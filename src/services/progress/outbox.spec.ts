import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from "vitest";

import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertUser } from "@/test/fixtures/users";
import type { Bindings } from "@/types/app";

import { drainUserProgressStatsOutbox } from "./outbox";
import type { ProgressStatsOutboxRecord } from "./repository";

const event: ProgressStatsOutboxRecord = {
  id: 1,
  eventId: "event",
  uid: "user",
  mutationId: "mutation",
  markerIndexHash: "hash",
  attempts: 0,
  createdAt: 0,
  payload: {
    eventId: "event",
    markerIndexHash: "hash",
    pointCount: 1,
    increments: [0],
    decrements: [],
    firstSync: true,
  },
};
describe("progress outbox delivery lifetime", () => {
  let database: TestDatabase;
  let env: Bindings;
  let stats: Mocked<DurableObjectStub>;

  function deliveryState() {
    return database.sqlite
      .prepare(`SELECT status, attempts, next_attempt_at,
      last_error, processed_at FROM progress_stats_outbox WHERE event_id = ?`)
      .get(event.eventId);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    database = createTestDatabase();
    insertUser(database.sqlite, { uid: event.uid });
    // Explicit epoch values keep dispatch/retry assertions independent of SQLite's real clock.
    database.sqlite
      .prepare(`INSERT INTO progress_stats_outbox
      (event_id, uid, mutation_id, marker_index_hash, payload, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, 0, 0)`)
      .run(
        event.eventId,
        event.uid,
        event.mutationId,
        event.markerIndexHash,
        JSON.stringify(event.payload),
      );
    const mocks = createMockBindings({ DB: database.db });
    env = mocks.bindings;
    const id: DurableObjectId = {
      name: event.markerIndexHash,
      toString: () => event.markerIndexHash,
      equals: (other) => other.name === event.markerIndexHash,
    };
    stats = {
      id,
      name: event.markerIndexHash,
      fetch: vi.fn<Fetcher["fetch"]>().mockImplementation(() => {
        throw new Error("Unconfigured OEM_STATS_DO.fetch");
      }),
      connect: vi.fn<Fetcher["connect"]>().mockImplementation(() => {
        throw new Error("Unconfigured OEM_STATS_DO.connect");
      }),
    };
    mocks.statsObjects.getByName.mockImplementation((name) => {
      if (name !== event.markerIndexHash) {
        throw new Error(`Unexpected Stats name: ${name}`);
      }
      return stats;
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    database.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("releases the acknowledgement body and cancels its deadline on success", async () => {
    const cancel = vi.fn();
    stats.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    await drainUserProgressStatsOutbox(env, "user");
    expect(cancel).toHaveBeenCalledOnce();
    expect(deliveryState()).toEqual({
      status: "processed",
      attempts: 0,
      next_attempt_at: 0,
      last_error: null,
      processed_at: 0,
    });
    expect(JSON.parse(String(stats.fetch.mock.calls[0]![1]!.body))).toEqual(event.payload);
    const signal = stats.fetch.mock.calls[0]![1]!.signal!;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal.aborted).toBe(false);
  });

  it("retains the 10-second deadline and durable retry after a transport timeout", async () => {
    stats.fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {
            once: true,
          });
        }),
    );
    const drain = drainUserProgressStatsOutbox(env, "user");
    await vi.advanceTimersByTimeAsync(9999);
    expect(deliveryState()).toEqual({
      status: "pending",
      attempts: 0,
      next_attempt_at: 0,
      last_error: null,
      processed_at: null,
    });
    const signal = stats.fetch.mock.calls[0]![1]!.signal!;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await drain;
    expect(signal.aborted).toBe(true);
    expect(deliveryState()).toEqual({
      status: "retry",
      attempts: 1,
      next_attempt_at: 70_000,
      last_error: "Stats delivery timed out",
      processed_at: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [400, true],
    [408, false],
    [429, false],
    [500, false],
  ])("preserves status %i retry/block classification", async (status, blocked) => {
    stats.fetch.mockResolvedValue(new Response("failure", { status }));
    await drainUserProgressStatsOutbox(env, "user");
    expect(deliveryState()).toEqual({
      status: blocked ? "blocked" : "retry",
      attempts: 1,
      next_attempt_at: 60_000,
      last_error: `Stats DO returned ${status}: failure`,
      processed_at: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans the deadline when fetch rejects before response headers", async () => {
    stats.fetch.mockRejectedValue(new Error("connection lost"));
    await drainUserProgressStatsOutbox(env, "user");
    expect(deliveryState()).toEqual({
      status: "retry",
      attempts: 1,
      next_attempt_at: 60_000,
      last_error: "connection lost",
      processed_at: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
