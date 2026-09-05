import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../types/app";
import type { NotificationRecord } from "../../repositories/notifications";

const mocks = vi.hoisted(() => ({ unread: vi.fn(), notification: vi.fn(), fanout: vi.fn() }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Bindings) {}
  }
}));
vi.mock("../../repositories/notifications", () => ({
  getNotificationUnreadCounts: mocks.unread,
  getNotificationById: mocks.notification,
  serializeNotificationItem: (notification: unknown) => notification
}));
import { OEMNotificationDO, publishNotificationsCreated } from "./live";

class TestSocket {
  attachment: unknown;
  send = vi.fn();
  close = vi.fn();
  serializeAttachment(value: unknown) { this.attachment = value; }
  deserializeAttachment() { return this.attachment; }
}

describe("notification Durable Object lifecycle", () => {
  let object: OEMNotificationDO;
  let sockets: TestSocket[];
  let accept: ReturnType<typeof vi.fn>;
  let env: Bindings;

  beforeEach(() => {
    vi.clearAllMocks();
    sockets = [];
    accept = vi.fn((socket: TestSocket) => sockets.push(socket));
    env = {
      DB: {}, OEM_NOTIFICATION_DO: { idFromName: (uid: string) => uid, get: () => ({ fetch: mocks.fanout }) }
    } as unknown as Bindings;
    object = new OEMNotificationDO({
      id: { name: "user-1" }, getWebSockets: () => sockets, acceptWebSocket: accept
    } as unknown as DurableObjectState, env);
    mocks.unread.mockResolvedValue({ system: 1, community: 0, total: 1 });
    vi.stubGlobal("WebSocketPair", class { 0 = new TestSocket(); 1 = new TestSocket(); });
    const NativeResponse = globalThis.Response;
    vi.stubGlobal("Response", class extends NativeResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        super(body, init?.status === 101 ? { status: 200 } : init);
        if (init?.status === 101) {
          Object.defineProperty(this, "status", { value: 101 });
          Object.defineProperty(this, "webSocket", { value: init.webSocket });
        }
      }
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const request = () => new Request("https://notify.internal/connect", {
    headers: { upgrade: "websocket", "x-oem-notify-user": "user-1", "x-oem-notify-client-id": "client-1" }
  });

  it("does not accept an orphan socket when the ready snapshot cannot be read", async () => {
    mocks.unread.mockRejectedValue(new Error("D1_ERROR: D1 DB is overloaded."));
    await expect(object.fetch(request())).rejects.toThrow("overloaded");
    expect(accept).not.toHaveBeenCalled();
  });

  it("replaces only the same client and sends the ready snapshot", async () => {
    const previous = new TestSocket();
    previous.serializeAttachment({ clientId: "client-1" });
    const anotherTab = new TestSocket();
    anotherTab.serializeAttachment({ clientId: "client-2" });
    sockets.push(previous, anotherTab);
    expect((await object.fetch(request())).status).toBe(101);
    expect(previous.close).toHaveBeenCalledWith(1000, "connection replaced");
    expect(anotherTab.close).not.toHaveBeenCalled();
    expect(sockets[2]!.send).toHaveBeenCalledWith(JSON.stringify({
      event: "notification.ready", unread: { system: 1, community: 0, total: 1 }
    }));
  });

  it("completes the close handshake and catches heartbeat send failures", async () => {
    const socket = new TestSocket();
    await object.webSocketClose(socket as unknown as WebSocket, 1000, "done", true);
    expect(socket.close).toHaveBeenCalledWith(1000, "peer closed");
    expect(console.warn).not.toHaveBeenCalled();
    socket.send.mockImplementation(() => { throw new Error("Network connection lost."); });
    await expect(object.webSocketMessage(socket as unknown as WebSocket, "aB123456")).resolves.toBeUndefined();
    expect(socket.close).toHaveBeenCalledWith(1011, "websocket error");
    expect(console.error).toHaveBeenCalled();
    socket.close.mockImplementation(() => { throw new Error("already closed"); });
    await expect(object.webSocketMessage(socket as unknown as WebSocket, "close")).resolves.toBeUndefined();
  });

  it("closes an accepted socket if sending its ready snapshot fails", async () => {
    accept.mockImplementation((socket: TestSocket) => {
      sockets.push(socket);
      socket.send.mockImplementation(() => { throw new Error("Network connection lost."); });
    });
    await expect(object.fetch(request())).rejects.toThrow("Network connection lost.");
    expect(sockets[0]!.close).toHaveBeenCalledWith(1011, "ready snapshot failed");
  });

  it("keeps committed notifications recoverable when live fanout fails", async () => {
    const notifications = ["first", "second"].map((id) => ({ id, recipientUserId: "user-1" }) as NotificationRecord);
    mocks.notification.mockImplementation(async (_database: unknown, id: string) => notifications.find((item) => item.id === id));
    mocks.fanout.mockRejectedValueOnce(new Error("Durable Object reset because its code was updated."))
      .mockResolvedValueOnce(Response.json({ delivered: 1 }));
    await expect(publishNotificationsCreated(env, notifications)).resolves.toBeUndefined();
    expect(mocks.fanout).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("remains persisted"), expect.objectContaining({ notificationId: "first" }));
  });
});
