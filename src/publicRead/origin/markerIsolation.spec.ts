import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ images: vi.fn(), comments: vi.fn() }));
vi.mock("../../repositories/submission/listImages", () => ({
  listActiveImagesByMarker: mocks.images,
  listImageViewerReactionsByMarker: vi.fn(),
  listUserImagesByMarker: vi.fn()
}));
vi.mock("../../repositories/submission/listComments", () => ({
  listActiveCommentsByMarker: mocks.comments,
  listCommentViewerStateByMarker: vi.fn(),
  listUserCommentsByMarker: vi.fn()
}));

import { listCachedPublicCommentsByMarker } from "./markerComments";
import { listCachedPublicImagesByMarker } from "./markerImages";

beforeEach(() => vi.resetAllMocks());

describe.each(["images", "comments"] as const)("%s invocation isolation", (kind) => {
  function read(db: D1Database, markerIds: string[], waitUntil = vi.fn(), kv?: KVNamespace) {
    const payload = {
      db, markerIds, waitUntil, kv, limit: 6, replyLimit: 3,
      cacheNamespace: "prod" as const, assetBaseUrl: "https://assets.example", excludePathPrefix: "_test"
    };
    return kind === "images"
      ? listCachedPublicImagesByMarker(payload)
      : listCachedPublicCommentsByMarker(payload);
  }

  it.each(["same", "different"])("does not block a %s-marker request behind another invocation", async (relation) => {
    const db = {} as D1Database;
    const query = mocks[kind];
    let finishFirst!: (value: []) => void;
    query.mockImplementationOnce(() => new Promise<[]>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue([]);
    const first = read(db, ["first"]);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    const second = read(db, [relation === "same" ? "first" : "second"]);
    try {
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2), { timeout: 100 });
      await expect(second).resolves.toEqual([]);
    } finally {
      finishFirst([]);
      await Promise.all([first, second]);
    }
  });

  it("still batches and deduplicates misses inside one invocation", async () => {
    const query = mocks[kind].mockResolvedValue([]);
    await expect(read({} as D1Database, ["first", "second", "first"])).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ markerIds: ["first", "second"] }));
  });

  it("registers cache writes on each invocation's own lifetime", async () => {
    const db = {} as D1Database;
    const kv = { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) } as unknown as KVNamespace;
    const firstWaitUntil = vi.fn();
    const secondWaitUntil = vi.fn();
    mocks[kind].mockResolvedValue([]);
    await Promise.all([
      read(db, ["same"], firstWaitUntil, kv),
      read(db, ["same"], secondWaitUntil, kv)
    ]);
    expect(firstWaitUntil).toHaveBeenCalledTimes(1);
    expect(secondWaitUntil).toHaveBeenCalledTimes(1);
    await Promise.all([...firstWaitUntil.mock.calls, ...secondWaitUntil.mock.calls].map(([promise]) => promise));
  });

  it("processes every missing marker in sequential batches of at most 100", async () => {
    const ids = Array.from({ length: 205 }, (_, index) => `marker-${index}`);
    let active = 0;
    let maximum = 0;
    mocks[kind].mockImplementation(async () => {
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      active--;
      return [];
    });
    await read({} as D1Database, [...ids, ids[0]!]);
    expect(mocks[kind].mock.calls.map(([, args]) => args.markerIds.length)).toEqual([100, 100, 5]);
    expect(mocks[kind].mock.calls.flatMap(([, args]) => args.markerIds)).toEqual(ids);
    expect(maximum).toBe(1);
  });

  it("preserves origin results when a cache write fails and retries a failed origin on the next invocation", async () => {
    const wait = vi.fn();
    const kv = { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockRejectedValue(new Error("KV unavailable")) } as unknown as KVNamespace;
    mocks[kind].mockRejectedValueOnce(new Error("D1 unavailable")).mockResolvedValue([]);
    await expect(read({} as D1Database, ["marker"], wait, kv)).rejects.toThrow("D1 unavailable");
    expect(wait).not.toHaveBeenCalled();
    await expect(read({} as D1Database, ["marker"], wait, kv)).resolves.toEqual([]);
    await Promise.all(wait.mock.calls.map(([promise]) => promise));
    expect(mocks[kind]).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });
});
