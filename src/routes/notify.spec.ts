import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bindings } from "@/types/app";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), fetch: vi.fn() }));
vi.mock("@/middleware/auth", () => ({ resolveRequestAuthUser: mocks.auth, requireAuth: vi.fn() }));
import { hmacServiceIdentifier } from "@/lib/serviceIdentity";

import { handleNotificationLiveUpgrade } from "./notify";
vi.mock("@/lib/serviceIdentity", () => ({ hmacServiceIdentifier: vi.fn(async () => "rate-key") }));

describe("notification WebSocket upgrade failures", () => {
  const env = {
    OEM_NOTIFICATION_DO: { idFromName: (uid: string) => uid, get: () => ({ fetch: mocks.fetch }) },
  } as unknown as Bindings;
  const request = () =>
    new Request("https://api.opendfieldmap.org/notify/v1/live?clientId=test-client", {
      headers: { upgrade: "websocket", "x-request-id": "test-request" },
    });

  beforeEach(() => {
    mocks.auth.mockResolvedValue({ uid: "user-1", role: "r" });
    mocks.fetch.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    "Connection closed: this Durable Object instance is no longer active.",
    "Durable Object reset because its code was updated.",
    "Durable Object storage is inaccessible.",
    "Durable Object storage operation timed out.",
  ])("catches asynchronous DO rejection: %s", async (message) => {
    mocks.fetch.mockRejectedValue(new Error(message));
    const response = await handleNotificationLiveUpgrade(request(), env);
    expect(response?.status).toBe(503);
    expect(response?.headers.get("retry-after")).toBe("5");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(await response?.json()).toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      requestId: "test-request",
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      "notification live upgrade failed",
      expect.objectContaining({
        stage: "notification_do",
        requestId: "test-request",
        stageDurationsMs: {
          auth: expect.any(Number),
          rate_limit: expect.any(Number),
          notification_do: expect.any(Number),
        },
        error: expect.objectContaining({ name: "Error", message }),
      }),
    );
  });

  it("identifies wrapped D1 failure in authentication", async () => {
    mocks.auth.mockRejectedValue(
      new Error("Failed to get session", {
        cause: new Error("D1_ERROR: Network connection lost."),
      }),
    );
    const response = await handleNotificationLiveUpgrade(request(), env);
    expect(response?.status).toBe(503);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "notification live upgrade failed",
      expect.objectContaining({
        stage: "auth",
        error: expect.objectContaining({
          cause: expect.objectContaining({ message: "D1_ERROR: Network connection lost." }),
        }),
      }),
    );
  });

  it("identifies capacity failure in the rate limiter", async () => {
    mocks.auth.mockResolvedValue({ uid: "user-1", role: "n" });
    const limit = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("busy"), { overloaded: true, retryable: true }));
    const response = await handleNotificationLiveUpgrade(request(), {
      ...env,
      OEM_AUTH_RATE_LIMIT: { limit },
    } as unknown as Bindings);
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ code: "DEPENDENCY_OVERLOADED" });
    expect(limit).toHaveBeenCalledTimes(1);
    expect(hmacServiceIdentifier).toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "notification live upgrade failed",
      expect.objectContaining({
        stage: "rate_limit",
        error: expect.objectContaining({ overloaded: true, retryable: true }),
      }),
    );
  });

  it("retains unknown failures as 500 without leaking diagnostic text", async () => {
    mocks.auth.mockRejectedValue(new Error("Failed to get session"));
    const response = await handleNotificationLiveUpgrade(request(), env);
    expect(response?.status).toBe(500);
    expect(await response?.text()).not.toContain("Failed to get session");
  });

  it("logs a returned upstream 500 at the notification stage", async () => {
    const upstream = new Response("opaque", { status: 500 });
    mocks.fetch.mockResolvedValue(upstream);
    await expect(handleNotificationLiveUpgrade(request(), env)).resolves.toBe(upstream);
    expect(console.error).toHaveBeenCalledWith(
      "notification live upgrade failed",
      expect.objectContaining({ stage: "notification_do", upstreamStatus: 500 }),
    );
  });

  it("returns successful upgrades unchanged", async () => {
    const response = { status: 101, webSocket: {} } as Response;
    mocks.fetch.mockResolvedValue(response);
    await expect(handleNotificationLiveUpgrade(request(), env)).resolves.toBe(response);
  });

  it("does not intercept ordinary HTTP requests", async () => {
    await expect(
      handleNotificationLiveUpgrade(
        new Request("https://api.opendfieldmap.org/notify/v1/live"),
        env,
      ),
    ).resolves.toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
