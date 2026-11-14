import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockBindings } from "./test/bindings";
import type { Bindings } from "./types/app";

const mocks = vi.hoisted(() => ({
  drain: vi.fn(),
  health: vi.fn(),
  cleanup: vi.fn(),
  karma: vi.fn<typeof import("./services/karma/evaluation").evaluateKarmaIfDue>(),
  moderation: vi.fn<typeof import("./queues/client/autoModeration").ensureAutoModerationBackfill>(),
  redis: vi.fn<typeof import("./lib/redis").createRedisClient>(),
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
vi.mock("./lib/redis", () => ({ createRedisClient: mocks.redis }));
vi.mock("./services/email", () => ({}));
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
  let env: Bindings;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.resetAllMocks();
    env = createMockBindings({ DB: {} as D1Database }).bindings;
    env.ENABLE_SCHEDULED_MODERATION = "false";
    mocks.drain.mockResolvedValue(undefined);
    mocks.cleanup.mockResolvedValue(undefined);
    mocks.health.mockResolvedValue({ pending: 0, blocked: 0, oldestAgeMs: 0 });
    mocks.redis.mockReturnValue({} as ReturnType<typeof mocks.redis>);
    mocks.karma.mockResolvedValue({
      evaluated: false,
      selected: 0,
      dirtySelected: 0,
      sweepSelected: 0,
      updated: 0,
      cycleComplete: false,
      nextRunAt: null,
    });
    mocks.moderation.mockResolvedValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function tick(time: string) {
    vi.setSystemTime(time);
    const waits: Promise<unknown>[] = [];
    await worker.scheduled({} as ScheduledEvent, env, {
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    } as unknown as ExecutionContext);
    // Observe all background work even when one waitUntil promise rejects.
    const results = await Promise.allSettled(waits);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
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

  it("reports Karma and the number of backfilled reviews after both jobs succeed", async () => {
    env.ENABLE_SCHEDULED_MODERATION = "true";
    mocks.moderation.mockResolvedValueOnce(3);

    await expect(tick("2026-09-05T12:01:00Z")).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith(
      "cron jobs completed",
      expect.objectContaining({
        karmaEvaluation: expect.objectContaining({ evaluated: false }),
        enqueued: 3,
        scheduledModerationEnabled: true,
      }),
    );
  });

  it("backfills pending reviews when Karma fails and still reports a failed cron", async () => {
    env.ENABLE_SCHEDULED_MODERATION = "true";
    mocks.karma.mockRejectedValueOnce(new Error("Karma Redis unavailable"));
    mocks.moderation.mockResolvedValueOnce(2);

    await expect(tick("2026-09-05T12:01:00Z")).rejects.toThrow();

    expect(mocks.moderation).toHaveBeenCalledExactlyOnceWith(env, 20);
    expect(mocks.drain).toHaveBeenCalledTimes(1);
  });

  it("backfills pending reviews even when constructing the Karma Redis client throws", async () => {
    env.ENABLE_SCHEDULED_MODERATION = "true";
    mocks.redis.mockImplementationOnce(() => {
      throw new Error("Invalid Redis configuration");
    });

    await expect(tick("2026-09-05T12:01:00Z")).rejects.toThrow();

    expect(mocks.moderation).toHaveBeenCalledExactlyOnceWith(env, 20);
    expect(mocks.karma).not.toHaveBeenCalled();
  });

  it("reports backfill failure after completing Karma evaluation", async () => {
    env.ENABLE_SCHEDULED_MODERATION = "true";
    mocks.moderation.mockRejectedValueOnce(new Error("Moderation queue unavailable"));

    await expect(tick("2026-09-05T12:01:00Z")).rejects.toThrow();

    expect(mocks.karma).toHaveBeenCalledTimes(1);
    expect(mocks.moderation).toHaveBeenCalledExactlyOnceWith(env, 20);
    expect(mocks.drain).toHaveBeenCalledTimes(1);
  });

  it("retains both failures when Karma and moderation backfill fail", async () => {
    env.ENABLE_SCHEDULED_MODERATION = "true";
    const karmaError = new Error("Karma Redis unavailable");
    const moderationError = new Error("Moderation queue unavailable");
    mocks.karma.mockRejectedValueOnce(karmaError);
    mocks.moderation.mockRejectedValueOnce(moderationError);

    await expect(tick("2026-09-05T12:01:00Z")).rejects.toMatchObject({
      errors: [karmaError, moderationError],
    });
    expect(console.warn).not.toHaveBeenCalledWith("cron jobs completed", expect.anything());
  });

  it("does not enable moderation backfill as a fallback when it is disabled", async () => {
    mocks.karma.mockRejectedValueOnce(new Error("Karma Redis unavailable"));

    await expect(tick("2026-09-05T12:01:00Z")).rejects.toThrow();

    expect(mocks.moderation).not.toHaveBeenCalled();
  });

  it("keeps locked scheduled jobs off while progress recovery continues", async () => {
    env.LOCK_SCHEDULED_JOBS = "true";
    env.ENABLE_SCHEDULED_MODERATION = "true";

    await tick("2026-09-05T12:01:00Z");

    expect(mocks.redis).not.toHaveBeenCalled();
    expect(mocks.karma).not.toHaveBeenCalled();
    expect(mocks.moderation).not.toHaveBeenCalled();
    expect(mocks.drain).toHaveBeenCalledTimes(1);
  });

  it("completes enabled backfill despite an independent progress recovery failure", async () => {
    env.ENABLE_SCHEDULED_MODERATION = "true";
    mocks.drain.mockRejectedValueOnce(new Error("Progress outbox unavailable"));

    await expect(tick("2026-09-05T12:01:00Z")).rejects.toThrow("Progress outbox unavailable");

    expect(mocks.karma).toHaveBeenCalledTimes(1);
    expect(mocks.moderation).toHaveBeenCalledExactlyOnceWith(env, 20);
  });
});
