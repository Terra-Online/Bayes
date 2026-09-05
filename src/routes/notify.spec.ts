import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../types/app";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), fetch: vi.fn() }));
vi.mock("../middleware/auth", () => ({ resolveRequestAuthUser: mocks.auth, requireAuth: vi.fn() }));
import { handleNotificationLiveUpgrade } from "./notify";

describe("notification WebSocket upgrade failures", () => {
  const env = {
    OEM_NOTIFICATION_DO: { idFromName: (uid: string) => uid, get: () => ({ fetch: mocks.fetch }) }
  } as unknown as Bindings;
  const request = () => new Request("https://api.opendfieldmap.org/notify/v1/live?clientId=test-client", {
    headers: { upgrade: "websocket", "x-request-id": "test-request" }
  });

  beforeEach(() => {
    mocks.auth.mockResolvedValue({ uid: "user-1", role: "r" });
    mocks.fetch.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    "Connection closed: this Durable Object instance is no longer active.",
    "Durable Object reset because its code was updated."
  ])("catches asynchronous DO rejection: %s", async (message) => {
    mocks.fetch.mockRejectedValue(new Error(message));
    const response = await handleNotificationLiveUpgrade(request(), env);
    expect(response?.status).toBe(503);
    expect(response?.headers.get("retry-after")).toBe("5");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(await response?.json()).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", requestId: "test-request" });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns successful upgrades unchanged", async () => {
    const response = { status: 101, webSocket: {} } as Response;
    mocks.fetch.mockResolvedValue(response);
    await expect(handleNotificationLiveUpgrade(request(), env)).resolves.toBe(response);
  });

  it("does not intercept ordinary HTTP requests", async () => {
    await expect(handleNotificationLiveUpgrade(new Request("https://api.opendfieldmap.org/notify/v1/live"), env)).resolves.toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
