import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "./types/app";

const mocks = vi.hoisted(() => ({
  drain: vi.fn(), health: vi.fn(), cleanup: vi.fn(), karma: vi.fn(), moderation: vi.fn()
}));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {}, DurableObject: class {}, exports: {} }));
vi.mock("@cloudflare/containers", () => ({ Container: class {} }));
vi.mock("./app", () => ({ createApp: () => ({ fetch: vi.fn() }) }));
vi.mock("./lib/redis", () => ({ createRedisClient: () => ({}) }));
vi.mock("./lib/config", () => ({ getRuntimeConfig: () => ({ scheduledModerationEnabled: false }) }));
vi.mock("./lib/email/sender", () => ({ initResend: vi.fn() }));
vi.mock("./services/karma/evaluation", () => ({ evaluateKarmaIfDue: mocks.karma }));
vi.mock("./services/progress/outbox", () => ({ drainProgressStatsOutbox: mocks.drain }));
vi.mock("./services/progress/repository", () => ({
  cleanupProgressConsistencyRecords: mocks.cleanup, getProgressStatsOutboxHealth: mocks.health
}));
vi.mock("./services/moderation/queue", () => ({ ensureModerationBackfill: mocks.moderation }));
import worker from "./index";

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
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  async function tick(time: string) {
    vi.setSystemTime(time);
    const waits: Promise<unknown>[] = [];
    await worker.scheduled({} as ScheduledEvent, { DB: {} } as Bindings, {
      waitUntil: (promise: Promise<unknown>) => waits.push(promise)
    } as unknown as ExecutionContext);
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
