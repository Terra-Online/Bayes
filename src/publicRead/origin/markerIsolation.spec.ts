import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { PublicReadCacheNamespace, PublicReadMarkerKind } from "@/publicRead/contract/markers";
import { invalidateUploadCaches } from "@/publicRead/invalidate";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";

import { listCachedPublicCommentsByMarker } from "./markerComments";
import { listCachedPublicImagesByMarker } from "./markerImages";

const workersCache = vi.hoisted(() => ({
  purgeMarker: vi.fn<(kind: PublicReadMarkerKind, markerId: string) => Promise<CachePurgeResult>>(),
}));
vi.mock("cloudflare:workers", () => ({ exports: { PublicReadCache: workersCache } }));

interface MarkerKv {
  binding: KVNamespace;
  values: Map<string, string>;
  get: Mock<(key: string) => Promise<string | null>>;
  put: Mock<KVNamespace["put"]>;
  delete: Mock<KVNamespace["delete"]>;
}

// Model only the KV text protocol used here; unexpected operations fail loudly.
function createMarkerKv(): MarkerKv {
  const values = new Map<string, string>();
  const methods = {
    get: vi.fn<(key: string) => Promise<string | null>>(async (key) => values.get(key) ?? null),
    put: vi.fn<KVNamespace["put"]>(async (key, value) => {
      if (typeof value !== "string") {
        throw new Error("Expected a JSON text cache write");
      }
      values.set(key, value);
    }),
    delete: vi.fn<KVNamespace["delete"]>(async (key) => {
      values.delete(key);
    }),
  };
  const binding = new Proxy({} as KVNamespace, {
    get(_target, property) {
      if (property === "get" || property === "put" || property === "delete") {
        return methods[property];
      }
      throw new Error(`Unconfigured marker KV operation: ${String(property)}`);
    },
  });
  return { binding, values, ...methods };
}

let database: TestDatabase;
beforeEach(() => {
  database = createTestDatabase();
  workersCache.purgeMarker.mockReset();
  workersCache.purgeMarker.mockRejectedValue(new Error("Unconfigured marker purge"));
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
  function read(
    db: D1Database,
    markerIds: string[],
    waitUntil = vi.fn(),
    kv?: KVNamespace,
    cacheNamespace: PublicReadCacheNamespace = "prod",
  ) {
    const payload = {
      db,
      markerIds,
      waitUntil,
      kv,
      limit: 6,
      replyLimit: 3,
      cacheNamespace,
      assetBaseUrl: "https://assets.example",
      excludePathPrefix: "_test",
    };
    return kind === "images"
      ? listCachedPublicImagesByMarker(payload)
      : listCachedPublicCommentsByMarker(payload);
  }

  it("repairs malformed cached lists from stored content and reuses positive and empty entries", async () => {
    insertUser(database.sqlite, { uid: "author" });
    insertSubmission(database.sqlite, {
      id: "stored",
      userId: "author",
      kind: kind === "images" ? "image" : "comment",
    });
    const before = database.sqlite.prepare("SELECT * FROM ugc_submissions").all();
    const kv = createMarkerKv();
    kv.get.mockResolvedValueOnce(JSON.stringify({ items: {} }));
    kv.get.mockResolvedValueOnce(JSON.stringify({ items: null }));
    const wait = vi.fn();

    const loaded = await read(database.db, ["marker-1", "empty"], wait, kv.binding);
    expect(loaded).toMatchObject([{ id: "stored", content: "Content stored" }]);
    await Promise.all(wait.mock.calls.map(([promise]) => promise));
    const queriesAfterMiss = database.queries.length;
    await expect(read(database.db, ["marker-1", "empty"], wait, kv.binding)).resolves.toEqual(
      loaded,
    );
    expect(database.queries).toHaveLength(queriesAfterMiss);
    kv.get.mockResolvedValueOnce("{");
    await expect(read(database.db, ["marker-1"], wait, kv.binding)).resolves.toEqual(loaded);
    await Promise.all(wait.mock.calls.map(([promise]) => promise));
    const queriesAfterRepair = database.queries.length;
    await expect(read(database.db, ["marker-1"], wait, kv.binding)).resolves.toEqual(loaded);
    expect(database.queries).toHaveLength(queriesAfterRepair);
    expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual(before);
  });

  it("evicts all KV namespaces after archival even when the Workers purge fails, and permits retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    insertUser(database.sqlite, { uid: "author" });
    insertSubmission(database.sqlite, {
      id: "stored",
      userId: "author",
      kind: kind === "images" ? "image" : "comment",
    });
    const kv = createMarkerKv();
    const wait = vi.fn();
    const namespaces = ["default", "test", "prod"] as const;
    for (const namespace of namespaces) {
      expect(await read(database.db, ["marker-1"], wait, kv.binding, namespace)).toMatchObject([
        { id: "stored" },
      ]);
      await Promise.all(wait.mock.calls.map(([promise]) => promise));
    }
    expect(kv.values.size).toBe(3);
    database.sqlite
      .prepare("UPDATE ugc_submissions SET status = 'stale' WHERE id = 'stored'")
      .run();
    const archived = database.sqlite.prepare("SELECT * FROM ugc_submissions").all();
    // Workers can report a failed purge or reject the RPC. Both must still allow
    // the separately owned KV entries to be removed and the caller to finish.
    if (kind === "images") {
      workersCache.purgeMarker.mockResolvedValueOnce({
        success: false,
        errors: [{ code: 503, message: "Purge unavailable" }],
      });
    } else {
      workersCache.purgeMarker.mockRejectedValueOnce(new Error("Purge connection lost"));
    }
    const invalidation = {
      kv: kv.binding,
      kind: kind === "images" ? ("image" as const) : ("comment" as const),
      markerId: "marker-1",
    };
    await invalidateUploadCaches(invalidation);
    expect(kv.values.size).toBe(0);
    for (const namespace of namespaces) {
      await expect(read(database.db, ["marker-1"], wait, kv.binding, namespace)).resolves.toEqual(
        [],
      );
      await Promise.all(wait.mock.calls.map(([promise]) => promise));
    }
    expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual(archived);

    workersCache.purgeMarker.mockResolvedValueOnce({ success: true, errors: [] });
    await invalidateUploadCaches(invalidation);
    expect(kv.values.size).toBe(0);
    expect(workersCache.purgeMarker.mock.calls).toEqual([
      [invalidation.kind, "marker-1"],
      [invalidation.kind, "marker-1"],
    ]);
  });

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
    insertUser(database.sqlite, { uid: "author" });
    insertSubmission(database.sqlite, {
      id: "stored",
      userId: "author",
      kind: kind === "images" ? "image" : "comment",
    });
    const before = database.sqlite.prepare("SELECT * FROM ugc_submissions").all();
    const wait = vi.fn();
    const kv = createMarkerKv();
    kv.get.mockRejectedValue(new Error("KV read unavailable"));
    kv.put.mockRejectedValue(new Error("KV write unavailable"));
    let attempts = 0;
    interceptReads(async () => {
      if (++attempts === 1) {
        throw new Error("D1 unavailable");
      }
    });
    await expect(read(database.db, ["marker-1"], wait, kv.binding)).rejects.toThrow(
      "D1 unavailable",
    );
    expect(wait).not.toHaveBeenCalled();
    expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual(before);
    await expect(read(database.db, ["marker-1"], wait, kv.binding)).resolves.toMatchObject([
      { id: "stored", content: "Content stored" },
    ]);
    await Promise.all(wait.mock.calls.map(([promise]) => promise));
    expect(attempts).toBe(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(database.sqlite.prepare("SELECT * FROM ugc_submissions").all()).toEqual(before);
  });
});
