import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bindings } from "./types/app";

const mocks = vi.hoisted(() => ({
  drain: vi.fn(),
  health: vi.fn(),
  cleanup: vi.fn(),
  karma: vi.fn(),
  moderation: vi.fn(),
  fetch: vi.fn(),
  upgrade: vi.fn(),
  requestLog: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
  DurableObject: class {},
  exports: {},
}));
vi.mock("@cloudflare/containers", () => ({ Container: class {} }));
vi.mock("./app", () => ({ createApp: () => ({ fetch: mocks.fetch }) }));
vi.mock("@/routes/notify/liveUpgrade", () => ({ handleNotificationLiveUpgrade: mocks.upgrade }));
vi.mock("./lib/redis", () => ({ createRedisClient: () => ({}) }));
vi.mock("./lib/config", () => ({
  getRuntimeConfig: () => ({ scheduledModerationEnabled: false }),
}));
vi.mock("./lib/email/sender", () => ({}));
vi.mock("./services/karma/evaluation", () => ({ evaluateKarmaIfDue: mocks.karma }));
vi.mock("./services/progress/outbox", () => ({ drainProgressStatsOutbox: mocks.drain }));
vi.mock("./services/progress/repository", () => ({
  cleanupProgressConsistencyRecords: mocks.cleanup,
  getProgressStatsOutboxHealth: mocks.health,
}));
vi.mock("./queues/client/autoModeration", () => ({
  ensureAutoModerationBackfill: mocks.moderation,
}));
import worker, { PublicReadCache } from "./index";

describe("HTTP entrypoint telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upgrade.mockResolvedValue(null);
    vi.spyOn(console, "log").mockImplementation(mocks.requestLog);
  });
  afterEach(() => vi.restoreAllMocks());

  it("passes through the default HTTP response and records the entrypoint", async () => {
    const response = new Response("ok", { headers: { "x-request-id": "response-id" } });
    mocks.fetch.mockResolvedValue(response);
    const request = new Request("https://api.example.test/resource");
    const env = {} as Bindings;
    const ctx = {} as ExecutionContext;
    expect(await worker.fetch(request, env, ctx)).toBe(response);
    expect(mocks.fetch).toHaveBeenCalledWith(request, env, ctx);
    expect(mocks.requestLog).toHaveBeenCalledWith(
      expect.objectContaining({ entrypoint: "default", status: 200, requestId: "response-id" }),
    );
  });

  it("keeps the WebSocket handle when bypassing Hono", async () => {
    const response = { status: 101, headers: new Headers(), webSocket: {} } as unknown as Response;
    mocks.upgrade.mockResolvedValue(response);
    expect(
      await worker.fetch(
        new Request("https://api.example.test/notify/v1/live", {
          headers: { upgrade: "websocket" },
        }),
        {} as Bindings,
        {} as ExecutionContext,
      ),
    ).toBe(response);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.requestLog).toHaveBeenCalledWith(
      expect.objectContaining({ entrypoint: "default", protocol: "websocket", status: 101 }),
    );
  });

  it("records public-read origin responses as internal calls", async () => {
    const entrypoint = new PublicReadCache({} as ExecutionContext, {} as Bindings);
    const response = await entrypoint.fetch(new Request("https://cache.internal/unknown"));
    expect(response.status).toBe(404);
    expect(mocks.requestLog).toHaveBeenCalledWith(
      expect.objectContaining({ entrypoint: "PublicReadCache", source: "internal", status: 404 }),
    );
  });
});

describe("scheduled database work", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.clearAllMocks();
    mocks.drain.mockResolvedValue(undefined);
    mocks.cleanup.mockResolvedValue(undefined);
    mocks.health.mockResolvedValue({ pending: 0, blocked: 0, oldestAgeMs: 0 });
    mocks.karma.mockResolvedValue({ evaluated: false });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function tick(time: string) {
    vi.setSystemTime(time);
    const waits: Promise<unknown>[] = [];
    await worker.scheduled(
      {} as ScheduledEvent,
      { DB: {} } as Bindings,
      {
        waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      } as unknown as ExecutionContext,
    );
    await Promise.all(waits);
  }

  it("keeps minute-level outbox recovery while sampling health every five minutes", async () => {
    await tick("2026-09-05T12:01:00Z");
    expect(mocks.drain).toHaveBeenCalledTimes(1);
    expect(mocks.karma).toHaveBeenCalledTimes(1);
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
    await tick("2026-09-05T12:05:00Z");
    expect(mocks.drain).toHaveBeenCalledTimes(2);
    expect(mocks.karma).toHaveBeenCalledTimes(2);
    expect(mocks.health).toHaveBeenCalledTimes(1);
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.moderation).not.toHaveBeenCalled();
  });

  it("still performs bounded retention cleanup on the hour", async () => {
    await tick("2026-09-05T13:00:00Z");
    expect(mocks.drain).toHaveBeenCalledTimes(1);
    expect(mocks.health).toHaveBeenCalledTimes(1);
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });
});
