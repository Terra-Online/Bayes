import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bindings } from "@/types/app";

import { drainUserProgressStatsOutbox } from "./outbox";
import type { ProgressStatsOutboxRecord } from "./repository";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  processed: vi.fn(),
  failed: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("./repository", () => ({
  listDispatchableProgressStatsEvents: mocks.list,
  markProgressStatsEventProcessed: mocks.processed,
  markProgressStatsEventFailed: mocks.failed,
}));
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
const env = {
  DB: {},
  OEM_STATS_DO: { getByName: () => ({ fetch: mocks.fetch }) },
} as unknown as Bindings;

describe("progress outbox delivery lifetime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.list.mockResolvedValueOnce([event]).mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("releases the acknowledgement body and cancels its deadline on success", async () => {
    const cancel = vi.fn();
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    await drainUserProgressStatsOutbox(env, "user");
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.processed).toHaveBeenCalledOnce();
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.fetch.mock.calls[0]![1].body)).toEqual(event.payload);
    const signal = mocks.fetch.mock.calls[0]![1].signal;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal.aborted).toBe(false);
  });

  it("retains the 10-second deadline and durable retry after a transport timeout", async () => {
    mocks.fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        }),
    );
    const drain = drainUserProgressStatsOutbox(env, "user");
    await vi.advanceTimersByTimeAsync(9999);
    expect(mocks.failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await drain;
    expect(mocks.failed).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ attempts: 1, blocked: false, nextAttemptAt: 70_000 }),
    );
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [400, true],
    [408, false],
    [429, false],
    [500, false],
  ])("preserves status %i retry/block classification", async (status, blocked) => {
    mocks.fetch.mockResolvedValue(new Response("failure", { status }));
    await drainUserProgressStatsOutbox(env, "user");
    expect(mocks.failed).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        blocked,
        attempts: 1,
        error: `Stats DO returned ${status}: failure`,
      }),
    );
    expect(mocks.processed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans the deadline when fetch rejects before response headers", async () => {
    mocks.fetch.mockRejectedValue(new Error("connection lost"));
    await drainUserProgressStatsOutbox(env, "user");
    expect(mocks.failed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
