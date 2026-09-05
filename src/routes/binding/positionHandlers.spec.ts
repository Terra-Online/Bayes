import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext, DecryptedBinding } from "./types";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), binding: vi.fn() }));
vi.mock("../../lib/endfieldClient/positionSocket", () => ({ connectEndfieldPositionSocket: mocks.connect }));
vi.mock("../../middleware/auth", () => ({ resolveAuthIdentity: vi.fn() }));
vi.mock("./credentials", () => ({
  getDecryptedBinding: mocks.binding,
  isAutoRefreshableEndfieldError: () => false,
  refreshBindingCredentials: vi.fn(),
  withAutoRefreshedBinding: vi.fn()
}));
vi.mock("./locatorTicket", () => ({ verifyLocatorSocketTicket: async () => "user-1", issueLocatorSocketTicket: vi.fn() }));
vi.mock("./locatorCache", () => ({ positionCache: new Map(), getPositionCacheKey: () => "key", refreshPositionCache: vi.fn() }));
import { handleEndfieldPositionSocket } from "./positionHandlers";
import { positionReconnectDelay } from "./helpers";

class TestSocket extends EventTarget {
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
}

describe("locator reconnection lifecycle", () => {
  let server: TestSocket;
  let context: AppContext;
  let waits: Promise<unknown>[];
  const callbacks: Array<{ onClose: () => void; onSubscribed: () => void; onError: () => void }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, "random").mockReturnValue(1);
    callbacks.length = 0;
    waits = [];
    server = new TestSocket();
    vi.stubGlobal("WebSocketPair", class { 0 = new TestSocket(); 1 = server; });
    vi.stubGlobal("Response", class { constructor(_body: unknown, readonly init: ResponseInit) {} });
    mocks.connect.mockReset().mockImplementation(async (_args, handlers) => {
      callbacks.push(handlers);
      return new TestSocket();
    });
    mocks.binding.mockResolvedValue({
      binding: { provider: "skland", role_id: "role-1", server_id: 1 },
      publicBinding: {}, cred: "test", token: "test", deviceProfile: {}
    } as DecryptedBinding);
    context = {
      req: {
        header: (key: string) => key === "upgrade" ? "websocket" : undefined,
        query: (key: string) => key === "ticket" ? "ticket" : undefined
      },
      env: {}, get: () => "request-1", executionCtx: { waitUntil: (promise: Promise<unknown>) => waits.push(promise) }
    } as unknown as AppContext;
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function connect() {
    await handleEndfieldPositionSocket(context);
    await Promise.all(waits);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("uses bounded jitter rather than fixed one-second retries", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map((attempt) => positionReconnectDelay(attempt, 1)))
      .toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(positionReconnectDelay(20, 0)).toBe(15000);
  });

  it("backs off rapid reconnects and cancels pending reconnect on client close", async () => {
    await connect();
    callbacks[0]!.onClose();
    callbacks[0]!.onError();
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    callbacks[1]!.onSubscribed();
    callbacks[1]!.onClose();
    await vi.advanceTimersByTimeAsync(1999);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.connect).toHaveBeenCalledTimes(3);
    callbacks[2]!.onClose();
    server.dispatchEvent(new Event("close"));
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.connect).toHaveBeenCalledTimes(3);
  });

  it("resets backoff only after a stable subscribed connection", async () => {
    await connect();
    callbacks[0]!.onClose();
    await vi.advanceTimersByTimeAsync(1000);
    callbacks[1]!.onSubscribed();
    await vi.advanceTimersByTimeAsync(60000);
    callbacks[1]!.onClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.connect).toHaveBeenCalledTimes(3);
  });

  it("ignores a failed in-flight upstream connection after the client has closed", async () => {
    let rejectConnection!: (reason: Error) => void;
    mocks.connect.mockImplementation(() => new Promise((_resolve, reject) => { rejectConnection = reject; }));
    await connect();
    server.dispatchEvent(new Event("close"));
    const sent = server.send.mock.calls.length;
    rejectConnection(new Error("Network connection lost."));
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(server.send).toHaveBeenCalledTimes(sent);
  });
});
