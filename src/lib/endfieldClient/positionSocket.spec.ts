import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectEndfieldPositionSocket, getEndfieldPositionFromSocket, getEndfieldPosition } from "./positionSocket";

vi.mock("./signature", () => ({ getSignature: async () => "signature", createMessageId: () => "message", getEndfieldTimestamp: () => "123" }));
vi.mock("./hosts", () => ({
  getEndfieldHosts: () => ({ baseUrl: "https://upstream.test", wsBaseUrl: "https://socket.test" }),
  buildDeviceHeaders: () => ({}), buildUrl: (base: string, path: string) => base + path,
  buildWebSocketHttpUrl: (base: string, path: string) => base + path,
}));

class Socket extends EventTarget {
  accept = vi.fn();
  send = vi.fn();
  // Deliberately does not dispatch close: cleanup must not await a peer event.
  close = vi.fn();
  message(payload: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) })); }
}
const args = { provider: "skland" as const, roleId: "role", serverId: 1, cred: "cred", token: "token" };
const position = { pos: { x: 1, y: 2, z: 3 }, levelId: "level", isOnline: true, mapId: "map" };

describe("managed upstream position socket lifecycle", () => {
  let socket: Socket;
  let fetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    socket = new Socket();
    fetch = vi.fn().mockImplementation(async (url: string) => url.includes("/token")
      ? Response.json({ code: 0, data: { token: "socket-token" } }) : { status: 101, webSocket: socket });
    vi.stubGlobal("fetch", fetch);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("retains subscription/heartbeat intervals and immediately releases timers/listeners on local close", async () => {
    const removed = vi.spyOn(socket, "removeEventListener");
    const handlers = { onSubscribed: vi.fn(), onError: vi.fn() };
    const connection = await connectEndfieldPositionSocket(args, handlers);
    socket.message({ type: 2 });
    expect(handlers.onSubscribed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.send.mock.calls.map(([payload]) => JSON.parse(payload).type).filter((type) => type === 3)).toHaveLength(2);
    connection.close(1000, "client closed");
    const sends = socket.send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.send).toHaveBeenCalledTimes(sends);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(removed.mock.calls.map(([type]) => type).sort()).toEqual(["close", "error", "message"]);
  });

  it.each(["close", "error"])("cleans a remote %s once and ignores stale frames", async (type) => {
    const handlers = { onClose: vi.fn(), onError: vi.fn(), onMessage: vi.fn() };
    await connectEndfieldPositionSocket(args, handlers);
    socket.message({ type: 2 });
    const event = new Event(type);
    if (type === "close") Object.defineProperty(event, "code", { value: 1006 });
    socket.dispatchEvent(event);
    socket.dispatchEvent(new Event(type));
    socket.message({ type: 1012, data: position });
    expect(type === "close" ? handlers.onClose : handlers.onError).toHaveBeenCalledOnce();
    expect(type === "close" ? handlers.onClose : handlers.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: type === "close" ? "remote-close" : "socket-error",
      phase: "subscribed",
      code: type === "close" ? 1006 : 1011,
      lifetimeMs: expect.any(Number)
    }));
    expect(handlers.onMessage).toHaveBeenCalledTimes(1); // Authentication acknowledgement only.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes and reports a heartbeat send failure even without a later close event", async () => {
    const onError = vi.fn();
    await connectEndfieldPositionSocket(args, { onError });
    socket.message({ type: 2 });
    socket.send.mockImplementation((payload: string) => {
      if (JSON.parse(payload).type === 3) throw new Error("connection lost");
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ kind: "send-failed", phase: "subscribed" }));
    expect(socket.close).toHaveBeenCalledWith(1011, "upstream error");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the existing authentication deadline and tears it down after firing", async () => {
    const onError = vi.fn();
    await connectEndfieldPositionSocket(args, { onError });
    await vi.advanceTimersByTimeAsync(8000);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ kind: "authentication-timeout", phase: "authenticating" }));
    expect(socket.close).toHaveBeenCalledWith(1011, "authentication timeout");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restart intervals when a subscription callback cancels the connection", async () => {
    const controller = new AbortController();
    await connectEndfieldPositionSocket({ ...args, signal: controller.signal }, { onSubscribed: () => controller.abort() });
    socket.message({ type: 2 });
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("cancels a pending handshake and closes a socket that arrives after cancellation", async () => {
    let finish!: (response: unknown) => void;
    fetch.mockImplementation(async (url: string) => url.includes("/token")
      ? Response.json({ code: 0, data: { token: "socket-token" } }) : new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const pending = getEndfieldPositionFromSocket({ ...args, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("client canceled");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    controller.abort(new Error("client canceled"));
    await rejected;
    finish({ status: 101, webSocket: socket });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.close).toHaveBeenCalledWith(1000, "request canceled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles one-shot position reads without leaving subscription timers", async () => {
    const pending = getEndfieldPositionFromSocket(args);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(0);
    socket.message({ type: 2 });
    socket.message({ type: 1012, data: position });
    await expect(pending).resolves.toEqual(position);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start socket recovery for an explicitly canceled HTTP request", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("canceled", "AbortError"));
    fetch.mockRejectedValue(controller.signal.reason);
    await expect(getEndfieldPosition({ ...args, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
