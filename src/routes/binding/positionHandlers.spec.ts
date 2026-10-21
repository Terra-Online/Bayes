import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppContext, DecryptedBinding } from "./types";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), binding: vi.fn() }));
vi.mock("@/lib/endfieldClient/positionSocket", () => ({
  connectEndfieldPositionSocket: mocks.connect,
}));
vi.mock("@/middleware/auth", () => ({ resolveAuthIdentity: vi.fn() }));
vi.mock("./credentials", () => ({
  getDecryptedBinding: mocks.binding,
  isAutoRefreshableEndfieldError: () => false,
  refreshBindingCredentials: vi.fn(),
  withAutoRefreshedBinding: vi.fn(),
}));
vi.mock("./locatorTicket", () => ({
  verifyLocatorSocketTicket: async () => "user-1",
  issueLocatorSocketTicket: vi.fn(),
}));
vi.mock("./locatorCache", () => ({
  readPositionCache: vi.fn(),
  writePositionCache: vi.fn(),
  getPositionCacheKey: () => "key",
  refreshPositionCache: vi.fn(),
}));
import type { EndfieldPositionTermination } from "@/lib/endfieldClient/positionSocket";
import { ApiError } from "@/lib/errors";

import { positionReconnectDelay } from "./helpers";
import { handleEndfieldPositionSocket } from "./positionHandlers";

class TestSocket extends EventTarget {
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
}

describe("locator reconnection lifecycle", () => {
  let server: TestSocket;
  let context: AppContext;
  let waits: Promise<unknown>[];
  const callbacks: Array<{
    onClose: (termination?: EndfieldPositionTermination) => void;
    onSubscribed: () => void;
    onError: (termination?: EndfieldPositionTermination) => void;
  }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, "random").mockReturnValue(1);
    callbacks.length = 0;
    waits = [];
    server = new TestSocket();
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = new TestSocket();
        1 = server;
      },
    );
    vi.stubGlobal(
      "Response",
      class {
        constructor(
          _body: unknown,
          readonly init: ResponseInit,
        ) {}
      },
    );
    mocks.connect.mockReset().mockImplementation(async (_args, handlers) => {
      callbacks.push(handlers);
      return new TestSocket();
    });
    mocks.binding.mockResolvedValue({
      binding: { provider: "skland", role_id: "role-1", server_id: 1 },
      publicBinding: {},
      cred: "test",
      token: "test",
      deviceProfile: {},
    } as DecryptedBinding);
    context = {
      req: {
        header: (key: string) => (key === "upgrade" ? "websocket" : undefined),
        query: (key: string) => (key === "ticket" ? "ticket" : undefined),
      },
      env: {},
      get: () => "request-1",
      executionCtx: { waitUntil: (promise: Promise<unknown>) => waits.push(promise) },
    } as unknown as AppContext;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function connect() {
    await handleEndfieldPositionSocket(context);
    await Promise.all(waits);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("uses bounded jitter rather than fixed one-second retries", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map((attempt) => positionReconnectDelay(attempt, 1))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
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

  it("records fixed upstream termination metadata without changing reconnect behavior", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await connect();
    callbacks[0]!.onClose({
      kind: "remote-close",
      phase: "subscribed",
      code: 1006,
      lifetimeMs: 12_345,
    });
    expect(warn).toHaveBeenCalledWith(
      "[locator][position-stream] reconnect scheduled",
      expect.objectContaining({
        reason: "upstream-closed",
        upstreamTermination: "remote-close",
        upstreamPhase: "subscribed",
        upstreamCode: 1006,
        upstreamConnectionLifetimeMs: 12_345,
      }),
    );
  });

  it("ignores a failed in-flight upstream connection after the client has closed", async () => {
    let rejectConnection!: (reason: Error) => void;
    mocks.connect.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectConnection = reject;
        }),
    );
    await connect();
    server.dispatchEvent(new Event("close"));
    const sent = server.send.mock.calls.length;
    rejectConnection(new Error("Network connection lost."));
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(server.send).toHaveBeenCalledTimes(sent);
  });

  it("aborts a pending upgrade and closes a late upstream connection", async () => {
    let finish!: (value: TestSocket) => void;
    mocks.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await connect();
    const signal = mocks.connect.mock.calls[0]![0].signal as AbortSignal;
    server.dispatchEvent(new Event("close"));
    expect(signal.aborted).toBe(true);
    const upstream = new TestSocket();
    finish(upstream);
    await vi.advanceTimersByTimeAsync(0);
    expect(upstream.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans client listeners immediately when the initial send fails", async () => {
    const remove = vi.spyOn(server, "removeEventListener");
    server.send.mockImplementation(() => {
      throw new Error("peer gone");
    });
    await connect();
    expect(server.close).toHaveBeenCalledWith(1011, "send failed");
    expect(remove.mock.calls.map(([type]) => type).sort()).toEqual(["close", "error", "message"]);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes an unauthorized stream with a policy code", async () => {
    mocks.binding.mockRejectedValueOnce(new ApiError(401, "UNAUTHORIZED", "invalid binding"));
    await connect();
    expect(server.close).toHaveBeenCalledWith(1008, "locator stream unavailable");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
