import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";

import { listCachedPublicCommentsByMarker } from "./markerComments";
import { listCachedPublicImagesByMarker } from "./markerImages";

let database: TestDatabase;
beforeEach(() => {
  database = createTestDatabase();
});
afterEach(() => {
  vi.restoreAllMocks();
  database.close();
});

// Intercept only D1 execution, keeping the origin and repository queries real.
function interceptReads(before: (values: unknown[]) => Promise<void>) {
  const prepare = database.db.prepare.bind(database.db);
  return vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    const bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => {
      const bound = bind(...values);
      const all = bound.all.bind(bound);
      bound.all = async <T>() => {
        await before(values);
        return all<T>();
      };
      return bound;
    };
    return statement;
  });
}

describe.each(["images", "comments"] as const)("%s invocation isolation", (kind) => {
  function read(db: D1Database, markerIds: string[], waitUntil = vi.fn(), kv?: KVNamespace) {
    const payload = {
      db,
      markerIds,
      waitUntil,
      kv,
      limit: 6,
      replyLimit: 3,
      cacheNamespace: "prod" as const,
      assetBaseUrl: "https://assets.example",
      excludePathPrefix: "_test",
    };
    return kind === "images"
      ? listCachedPublicImagesByMarker(payload)
      : listCachedPublicCommentsByMarker(payload);
  }

  it.each(["same", "different"])(
    "does not block a %s-marker request behind another invocation",
    async (relation) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      interceptReads(async () => {
        if (++calls === 1) {
          await gate;
        }
      });
      const first = read(database.db, ["first"]);
      const requests: Promise<unknown>[] = [first];
      try {
        await vi.waitFor(() => expect(calls).toBe(1));
        let secondFinished = false;
        const second = read(database.db, [relation === "same" ? "first" : "second"]).then(
          (items) => {
            secondFinished = true;
            return items;
          },
        );
        requests.push(second);
        await vi.waitFor(() => expect(secondFinished).toBe(true), { timeout: 100 });
        expect(calls).toBe(2);
        await expect(second).resolves.toEqual([]);
      } finally {
        release();
        await Promise.all(requests);
      }
    },
  );

  it("still batches and deduplicates misses inside one invocation", async () => {
    await expect(read(database.db, ["first", "second", "first"])).resolves.toEqual([]);
    expect(database.queries).toHaveLength(1);
    expect(JSON.parse(String(database.queries[0]!.values[0]))).toEqual(["first", "second"]);
  });

  it("registers cache writes on each invocation's own lifetime", async () => {
    const db = database.db;
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace;
    const firstWaitUntil = vi.fn();
    const secondWaitUntil = vi.fn();
    await Promise.all([
      read(db, ["same"], firstWaitUntil, kv),
      read(db, ["same"], secondWaitUntil, kv),
    ]);
    expect(firstWaitUntil).toHaveBeenCalledTimes(1);
    expect(secondWaitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(
      [...firstWaitUntil.mock.calls, ...secondWaitUntil.mock.calls].map(([promise]) => promise),
    );
  });

  it("processes every missing marker in sequential batches of at most 100", async () => {
    const ids = Array.from({ length: 205 }, (_, index) => `marker-${index}`);
    let active = 0;
    let maximum = 0;
    interceptReads(async () => {
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      active--;
    });
    await read(database.db, [...ids, ids[0]!]);
    const batches = database.queries.map(
      (query) => JSON.parse(String(query.values[0])) as string[],
    );
    expect(batches.map((ids) => ids.length)).toEqual([100, 100, 5]);
    expect(batches.flat()).toEqual(ids);
    expect(maximum).toBe(1);
  });

  it("preserves origin results when a cache write fails and retries a failed origin on the next invocation", async () => {
    const wait = vi.fn();
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockRejectedValue(new Error("KV unavailable")),
    } as unknown as KVNamespace;
    let attempts = 0;
    interceptReads(async () => {
      if (++attempts === 1) {
        throw new Error("D1 unavailable");
      }
    });
    await expect(read(database.db, ["marker"], wait, kv)).rejects.toThrow("D1 unavailable");
    expect(wait).not.toHaveBeenCalled();
    await expect(read(database.db, ["marker"], wait, kv)).resolves.toEqual([]);
    await Promise.all(wait.mock.calls.map(([promise]) => promise));
    expect(attempts).toBe(2);
    expect(wait).toHaveBeenCalledOnce();
  });
});
