import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sha256Hex } from "@/lib/crypto";
import { onAppError } from "@/middleware/error-handler";
import { PublicReadCache } from "@/publicRead/origin/entrypoint";
import { buildCanonicalArchiveManifest } from "@/services/progress/archiveManifest";
import { buildCanonicalMarkerManifest } from "@/services/progress/manifest";
import { OEMStatsDO } from "@/services/progress/statsDo";
import { OEMUserDO } from "@/services/progress/userDo";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession, testAuthConfig } from "@/test/fixtures/auth";
import { createProgressTestState, type ProgressTestState } from "@/test/fixtures/progressRuntime";
import { insertUser } from "@/test/fixtures/users";
import type { AppEnv } from "@/types/app";

import { createRoutes } from "./createRoutes";

let database: TestDatabase;
let env: AppEnv["Bindings"];
let sessions: Record<string, { authorization: string }>;
let users: Map<string, OEMUserDO>;
let stats: Map<string, OEMStatsDO>;
let statsStates: Map<string, ProgressTestState>;
let pendingStatsDeliveries: Promise<unknown>[];
let kv: Map<string, string>;
let statsDelivery: (request: Request, object: OEMStatsDO) => Promise<Response>;
let publicCache: PublicReadCache;

async function buildManifestPayload(kind: "map" | "archive", ids: string[]) {
  const hash = await sha256Hex(
    kind === "map" ? buildCanonicalMarkerManifest(ids) : buildCanonicalArchiveManifest(ids),
  );
  return kind === "map"
    ? { markerIndexHash: hash, pointIds: ids }
    : { archiveIndexHash: hash, archiveIds: ids };
}

beforeEach(() => {
  database = createTestDatabase();
  sessions = {};
  for (const [uid, uidNumber] of [
    ["explorer", 100001],
    ["other", 100002],
  ] as const) {
    insertUser(database.sqlite, { uid, uid_number: uidNumber });
    insertAuthUser(database.sqlite, { id: uid });
    sessions[uid] = insertSession(database.sqlite, { userId: uid }).headers;
  }
  users = new Map();
  stats = new Map();
  statsStates = new Map();
  pendingStatsDeliveries = [];
  kv = new Map();
  statsDelivery = (request, object) => object.fetch(request);
  const getStats = (name: string) => {
    let object = stats.get(name);
    if (!object) {
      let runtime = statsStates.get(name);
      if (!runtime) {
        runtime = createProgressTestState(name);
        statsStates.set(name, runtime);
      }
      object = new OEMStatsDO(runtime.state, env);
      stats.set(name, object);
    }
    return {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        statsDelivery(new Request(input, init), object),
    };
  };
  env = {
    ...testAuthConfig,
    DB: database.db,
    LOCK_PROGRESS_ENDPOINTS: "false",
    OEM_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
    },
    OEM_USER_DO: {
      getByName: (name: string) => {
        let object = users.get(name);
        if (!object) {
          const runtime = createProgressTestState(name);
          // Each named object has independent storage and a production queue.
          runtime.state.waitUntil = (work) => {
            pendingStatsDeliveries.push(work);
          };
          object = new OEMUserDO(runtime.state, env);
          users.set(name, object);
        }
        return { fetch: (request: Request) => object.fetch(request) };
      },
    },
    OEM_STATS_DO: { getByName: getStats, idFromName: (name: string) => name, get: getStats },
  } as unknown as AppEnv["Bindings"];
  publicCache = new PublicReadCache({} as ExecutionContext, env);
});

afterEach(async () => {
  await drainStatsDeliveries();
  vi.restoreAllMocks();
  database.close();
});

async function drainStatsDeliveries() {
  while (pendingStatsDeliveries.length) {
    await Promise.all(pendingStatsDeliveries.splice(0));
  }
}

function request(path: string, body?: unknown, user: string | null = "explorer") {
  const app = new Hono<AppEnv>().onError(onAppError).route("/progress/v1", createRoutes());
  return app.request(
    `http://localhost/progress/v1${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(user ? sessions[user] : {}), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}

async function registerManifest(kind: "map" | "archive" = "map", ids = ["p1", "p2"]) {
  const manifest = await buildManifestPayload(kind, ids);
  const response = await request(kind === "map" ? "/manifest" : "/archive/manifest", manifest);
  expect(response.status).toBe(200);
  return ("markerIndexHash" in manifest ? manifest.markerIndexHash : manifest.archiveIndexHash)!;
}

async function readProgress(hash: string, kind: "map" | "archive" = "map", user = "explorer") {
  const response = await request(
    kind === "map" ? `/state?markerIndexHash=${hash}` : `/archive/state?archiveIndexHash=${hash}`,
    undefined,
    user,
  );
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      progress: { revision: string; pointIds?: string[]; archiveIds?: string[] };
    }
  ).progress;
}

function syncProgress(
  hash: string,
  mutationId: string,
  patch: Record<string, unknown> = {},
  kind: "map" | "archive" = "map",
  user = "explorer",
) {
  return request(
    kind === "map" ? "/sync?uid=other" : "/archive/sync?uid=other",
    {
      baseRevision: "",
      clientMutationId: mutationId,
      [kind === "map" ? "markerIndexHash" : "archiveIndexHash"]: hash,
      updatedAt: 1_700_000_000_000,
      ...patch,
    },
    user,
  );
}

async function expectAcceptedSync(
  response: Response,
): Promise<{ ok: boolean; progress: { revision: string }; unchanged?: boolean }> {
  expect(response.status).toBe(200);
  return response.json();
}

async function readPublicStats(hash: string) {
  const response = await request(`/stats?markerIndexHash=${hash}`, undefined, null);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    counts: string;
    sampleSize: number;
    totalSyncedUsers: number;
    pointCount: number;
    markerIndexHash: string;
  };
  const bytes = Buffer.from(body.counts, "base64");
  return {
    response,
    body,
    counts: Array.from({ length: bytes.length / 4 }, (_, index) => bytes.readUInt32LE(index * 4)),
  };
}

describe("progress community stats HTTP", () => {
  it("preserves collections in an unchanged bitmap byte while removing a point in the next byte", async () => {
    const ids = ["p01", "p02", "p03", "p04", "p05", "p06", "p07", "p08", "p09"];
    const hash = await registerManifest("map", ids);
    const first = await expectAcceptedSync(
      await syncProgress(hash, "across-bytes", { setPointIds: ["p01", "p09"] }),
    );
    await drainStatsDeliveries();
    await expectAcceptedSync(
      await syncProgress(hash, "remove-last", {
        baseRevision: first.progress.revision,
        clearPointIds: ["p09"],
      }),
    );
    await drainStatsDeliveries();
    expect(await readProgress(hash)).toMatchObject({ pointIds: ["p01"] });
    const result = await readPublicStats(hash);
    expect(result.body).toMatchObject({ pointCount: 9, sampleSize: 1, totalSyncedUsers: 1 });
    expect(result.counts).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("does not cache a failed stats read and recovers on the next public request", async () => {
    const hash = await registerManifest();
    statsDelivery = async () => Response.json({ code: "STATS_UNAVAILABLE" }, { status: 503 });
    const failed = await request(`/stats?markerIndexHash=${hash}`, undefined, null);
    expect(failed.status).toBe(503);
    expect(failed.headers.get("cache-control")).toBe("private, no-store");
    expect(await failed.json()).toEqual({ code: "STATS_UNAVAILABLE" });
    statsDelivery = (request, object) => object.fetch(request);
    const recovered = await readPublicStats(hash);
    expect(recovered.body.sampleSize).toBe(0);
    expect(recovered.response.headers.get("x-oem-kv-cache")).toBe("miss");
  });

  it("returns an empty public sample for a dataset without contributions", async () => {
    const result = await readPublicStats("a".repeat(64));
    expect(result.body).toEqual({
      markerIndexHash: "a".repeat(64),
      pointCount: 0,
      totalSyncedUsers: 0,
      sampleSize: 0,
      counts: "",
      updatedAt: null,
    });
  });

  it("keeps a permanently rejected stats event and later events for that owner blocked while other owners continue", async () => {
    const hash = await registerManifest();
    statsDelivery = async () => new Response("dataset rejected", { status: 409 });
    const first = await expectAcceptedSync(
      await syncProgress(hash, "blocked-event", { setPointIds: ["p1"] }),
    );
    await drainStatsDeliveries();
    statsDelivery = (request, object) => object.fetch(request);
    await expectAcceptedSync(
      await syncProgress(hash, "after-blocked", {
        baseRevision: first.progress.revision,
        setPointIds: ["p2"],
      }),
    );
    await drainStatsDeliveries();
    await expectAcceptedSync(
      await syncProgress(hash, "unaffected-owner", { setPointIds: ["p2"] }, "map", "other"),
    );
    await drainStatsDeliveries();
    expect(
      database.sqlite
        .prepare("SELECT mutation_id, status, attempts FROM progress_stats_outbox ORDER BY id")
        .all(),
    ).toEqual([
      { mutation_id: "blocked-event", status: "blocked", attempts: 1 },
      { mutation_id: "after-blocked", status: "pending", attempts: 0 },
      { mutation_id: "unaffected-owner", status: "processed", attempts: 0 },
    ]);
    expect(await readProgress(hash)).toMatchObject({ pointIds: ["p1", "p2"] });
    const result = await readPublicStats(hash);
    expect(result.body.sampleSize).toBe(1);
    expect(result.counts).toEqual([0, 1]);
  });

  it("retries a lost stats acknowledgement in order after object recreation without counting a collection twice", async () => {
    const hash = await registerManifest();
    let loseAcknowledgement = true;
    statsDelivery = async (request, object) => {
      const response = await object.fetch(request);
      if (new URL(request.url).pathname === "/apply" && loseAcknowledgement) {
        loseAcknowledgement = false;
        return new Response("acknowledgement lost", { status: 503 });
      }
      return response;
    };
    const first = await expectAcceptedSync(
      await syncProgress(hash, "before-offline", { setPointIds: ["p1"] }),
    );
    await drainStatsDeliveries();
    const eventAwaitingRetry = database.sqlite
      .prepare("SELECT status, attempts, next_attempt_at FROM progress_stats_outbox")
      .get();
    expect(eventAwaitingRetry).toMatchObject({ status: "retry", attempts: 1 });
    const second = await expectAcceptedSync(
      await syncProgress(hash, "while-offline", {
        baseRevision: first.progress.revision,
        clearPointIds: ["p1"],
        setPointIds: ["p2"],
      }),
    );
    await drainStatsDeliveries();
    expect(await readProgress(hash)).toMatchObject({ pointIds: ["p2"] });
    expect(
      database.sqlite
        .prepare("SELECT mutation_id, status FROM progress_stats_outbox ORDER BY id")
        .all(),
    ).toEqual([
      { mutation_id: "before-offline", status: "retry" },
      { mutation_id: "while-offline", status: "pending" },
    ]);
    // Recreate the stats object with its existing storage so its receipt must
    // prevent the already-applied event from incrementing counts again.
    stats.clear();
    users.clear();
    vi.spyOn(Date, "now").mockReturnValue(Number(eventAwaitingRetry!.next_attempt_at) + 1);
    const refresh = await expectAcceptedSync(
      await syncProgress(hash, "back-online", {
        baseRevision: second.progress.revision,
        setPointIds: ["p2"],
      }),
    );
    expect(refresh.unchanged).toBe(true);
    await drainStatsDeliveries();
    expect(
      database.sqlite
        .prepare("SELECT mutation_id, status, attempts FROM progress_stats_outbox ORDER BY id")
        .all(),
    ).toEqual([
      { mutation_id: "before-offline", status: "processed", attempts: 1 },
      { mutation_id: "while-offline", status: "processed", attempts: 0 },
    ]);
    const result = await readPublicStats(hash);
    expect(result.body).toMatchObject({ sampleSize: 1, totalSyncedUsers: 1 });
    expect(result.counts).toEqual([0, 1]);
  });

  it("reports collected point counts and sample size publicly after owners add and clear collections", async () => {
    const hash = await registerManifest();
    const first = await expectAcceptedSync(
      await syncProgress(hash, "explorer-first", { setPointIds: ["p1"] }),
    );
    await drainStatsDeliveries();
    await expectAcceptedSync(
      await syncProgress(hash, "other-first", { setPointIds: ["p1", "p2"] }, "map", "other"),
    );
    await drainStatsDeliveries();
    await expectAcceptedSync(
      await syncProgress(hash, "explorer-moved", {
        baseRevision: first.progress.revision,
        clearPointIds: ["p1"],
        setPointIds: ["p2"],
      }),
    );
    await drainStatsDeliveries();
    const readStatsObject = vi.fn(statsDelivery);
    statsDelivery = readStatsObject;
    const result = await readPublicStats(`%20${hash.toUpperCase()}%20`);
    expect(result.body).toMatchObject({
      markerIndexHash: hash,
      pointCount: 2,
      totalSyncedUsers: 2,
      sampleSize: 2,
    });
    expect(result.counts).toEqual([1, 2]);
    expect(result.response.headers.get("cache-control")).toMatch(/^public, max-age=\d+$/);
    expect(result.response.headers.get("cloudflare-cdn-cache-control")).toMatch(
      /^public, max-age=\d+$/,
    );
    expect(result.response.headers.get("x-oem-kv-cache")).toBe("miss");
    expect(readStatsObject).toHaveBeenCalledOnce();
    // Repeated public reads must not spend another statistics-object request.
    const cached = await readPublicStats(hash);
    expect(cached.body).toEqual(result.body);
    expect(cached.response.headers.get("x-oem-kv-cache")).toBe("hit");
    expect(readStatsObject).toHaveBeenCalledOnce();
  });
});

describe("persisted progress HTTP sync", () => {
  it("restores collected archives when their index entries return, clears retained archives, and leaves map progress untouched", async () => {
    const mapHash = await registerManifest();
    await expectAcceptedSync(
      await syncProgress(mapHash, "map-collection", { setPointIds: ["p2"] }),
    );
    await drainStatsDeliveries();
    const mapBefore = await readProgress(mapHash);
    const original = await registerManifest("archive", ["p1", "p2"]);
    const first = await expectAcceptedSync(
      await syncProgress(
        original,
        "archive-collection",
        { setArchiveIds: ["p1", "p2", "offline-old"] },
        "archive",
      ),
    );
    const reduced = await registerManifest("archive", ["p2", "p3"]);
    kv.clear();
    const projected = await readProgress(reduced, "archive");
    expect(projected).toMatchObject({ archiveIndexHash: reduced, archiveIds: ["p2"] });
    // Reading a new index projects progress without committing a migration.
    expect(
      database.sqlite
        .prepare("SELECT version, checksum FROM user_archive_progress WHERE uid = 'explorer'")
        .get(),
    ).toEqual({ version: 1, checksum: first.progress.revision });
    await expectAcceptedSync(
      await syncProgress(
        reduced,
        "archive-index-update",
        {
          baseRevision: projected.revision,
          clearArchiveIds: ["offline-old"],
          setArchiveIds: ["p3"],
        },
        "archive",
      ),
    );
    expect(await readProgress(reduced, "archive")).toMatchObject({ archiveIds: ["p2", "p3"] });
    expect(
      database.sqlite
        .prepare("SELECT retained_archive_ids FROM user_archive_progress WHERE uid = 'explorer'")
        .get(),
    ).toEqual({ retained_archive_ids: '["p1"]' });
    const expanded = await registerManifest("archive", ["p1", "p2", "p3"]);
    const restored = await readProgress(expanded, "archive");
    expect(restored).toMatchObject({ archiveIds: ["p1", "p2", "p3"] });
    await expectAcceptedSync(
      await syncProgress(
        expanded,
        "archive-return",
        { baseRevision: restored.revision },
        "archive",
      ),
    );
    users.clear();
    kv.clear();
    expect(await readProgress(expanded, "archive")).toMatchObject({
      archiveIds: ["p1", "p2", "p3"],
    });
    expect(
      database.sqlite
        .prepare("SELECT retained_archive_ids FROM user_archive_progress WHERE uid = 'explorer'")
        .get(),
    ).toEqual({ retained_archive_ids: "[]" });
    expect(await readProgress(mapHash)).toEqual(mapBefore);
    expect(database.sqlite.prepare("SELECT mutation_id FROM progress_stats_outbox").all()).toEqual([
      { mutation_id: "map-collection" },
    ]);
  });

  it("keeps removed map points and offline unknown points acknowledged when the map index changes", async () => {
    const original = await registerManifest();
    const collected = await expectAcceptedSync(
      await syncProgress(original, "collected-before-map-update", {
        setPointIds: ["p1", "p2", "offline-old"],
      }),
    );
    await drainStatsDeliveries();
    const reduced = await registerManifest("map", ["p2", "p3"]);
    kv.clear();
    expect(await readProgress(reduced)).toMatchObject({
      revision: collected.progress.revision,
      markerIndexHash: original,
      pointIds: ["p2"],
      retainedPointIds: ["offline-old", "p1"],
    });
    expect(
      database.sqlite.prepare("SELECT progress_version FROM users WHERE uid = 'explorer'").get(),
    ).toEqual({ progress_version: 1 });
    const migrated = await expectAcceptedSync(
      await syncProgress(reduced, "new-map", {
        baseRevision: collected.progress.revision,
        setPointIds: ["p3"],
      }),
    );
    await drainStatsDeliveries();
    users.clear();
    kv.clear();
    expect(await readProgress(reduced)).toMatchObject({
      revision: migrated.progress.revision,
      markerIndexHash: reduced,
      pointIds: ["p2", "p3"],
      retainedPointIds: ["offline-old", "p1"],
    });
    const stale = await syncProgress(reduced, "stale-new-map", { setPointIds: ["p1"] });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      details: { current: { pointIds: ["p2", "p3"], retainedPointIds: ["offline-old", "p1"] } },
    });
  });

  it("acknowledges an additional offline point without changing the public sample or known collections", async () => {
    const hash = await registerManifest();
    const first = await expectAcceptedSync(
      await syncProgress(hash, "known-point", { setPointIds: ["p1"] }),
    );
    await drainStatsDeliveries();
    const saved = await expectAcceptedSync(
      await syncProgress(hash, "offline-point", {
        baseRevision: first.progress.revision,
        setPointIds: ["offline-future"],
        clearPointIds: ["never-collected"],
      }),
    );
    await drainStatsDeliveries();
    users.clear();
    expect(await readProgress(hash)).toMatchObject({
      revision: saved.progress.revision,
      pointIds: ["p1"],
      retainedPointIds: ["offline-future"],
    });
    expect(
      database.sqlite.prepare("SELECT count(*) AS count FROM progress_stats_outbox").get(),
    ).toEqual({ count: 1 });
    const result = await readPublicStats(hash);
    expect(result.body).toMatchObject({ sampleSize: 1, totalSyncedUsers: 1 });
    expect(result.counts).toEqual([1, 0]);
  });

  it.each(["map", "archive"] as const)(
    "rolls back all %s writes on database failure and lets the identical mutation succeed on retry",
    async (kind) => {
      const hash = await registerManifest(kind);
      const table = kind === "map" ? "progress_stats_outbox" : "archive_progress_sync_mutations";
      // Fail a later write in a real SQLite transaction, after progress was written.
      database.sqlite.exec(`CREATE TEMP TRIGGER unavailable_sync_storage BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`);
      const patch = { [kind === "map" ? "setPointIds" : "setArchiveIds"]: ["p1"] };
      const failed = await syncProgress(hash, "retry-after-failure", patch, kind);
      expect(failed.status).toBe(500);
      expect(failed.headers.get("cache-control")).toBe("private, no-store");
      expect(await failed.json()).toMatchObject({ code: "PROGRESS_INTERNAL_ERROR" });
      expect(await readProgress(hash, kind)).toMatchObject({
        revision: "",
        [kind === "map" ? "pointIds" : "archiveIds"]: [],
      });
      for (const emptyTable of [
        "progress_sync_mutations",
        "archive_progress_sync_mutations",
        "progress_stats_outbox",
        "user_archive_progress",
      ]) {
        expect(database.sqlite.prepare(`SELECT * FROM ${emptyTable}`).all()).toEqual([]);
      }
      expect(
        database.sqlite
          .prepare(
            "SELECT progress_version, progress_cloud_synced, progress_last_mutation_id FROM users WHERE uid = 'explorer'",
          )
          .get(),
      ).toEqual({ progress_version: 0, progress_cloud_synced: 0, progress_last_mutation_id: null });
      database.sqlite.exec("DROP TRIGGER unavailable_sync_storage");
      await expectAcceptedSync(await syncProgress(hash, "retry-after-failure", patch, kind));
      await drainStatsDeliveries();
      expect(await readProgress(hash, kind)).toMatchObject({
        [kind === "map" ? "pointIds" : "archiveIds"]: ["p1"],
      });
    },
  );

  it.each(["map", "archive"] as const)(
    "allows only one of two %s writes based on the same revision",
    async (kind) => {
      const hash = await registerManifest(kind);
      const setIdsField = kind === "map" ? "setPointIds" : "setArchiveIds";
      const collectedIdsField = kind === "map" ? "pointIds" : "archiveIds";
      const responses = await Promise.all([
        syncProgress(hash, "phone", { [setIdsField]: ["p1"] }, kind),
        syncProgress(hash, "laptop", { [setIdsField]: ["p2"] }, kind),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const winner = responses.findIndex((response) => response.status === 200);
      const saved = await expectAcceptedSync(responses[winner]);
      expect(await responses[1 - winner].json()).toMatchObject({
        details: {
          current: {
            revision: saved.progress.revision,
            [collectedIdsField]: [winner === 0 ? "p1" : "p2"],
          },
        },
      });
      expect(await readProgress(hash, kind)).toMatchObject({
        revision: saved.progress.revision,
        [collectedIdsField]: [winner === 0 ? "p1" : "p2"],
      });
      await drainStatsDeliveries();
    },
  );

  it.each(["map", "archive"] as const)(
    "isolates %s progress and mutation IDs by authenticated owner despite a forged identity",
    async (kind) => {
      const hash = await registerManifest(kind);
      const setIdsField = kind === "map" ? "setPointIds" : "setArchiveIds";
      const collectedIdsField = kind === "map" ? "pointIds" : "archiveIds";
      await expectAcceptedSync(
        await syncProgress(
          hash,
          "device-mutation-1",
          { uid: "other", [setIdsField]: ["p1"] },
          kind,
        ),
      );
      await drainStatsDeliveries();
      expect(await readProgress(hash, kind, "other")).toMatchObject({
        revision: "",
        [collectedIdsField]: [],
      });
      await expectAcceptedSync(
        await syncProgress(
          hash,
          "device-mutation-1",
          { uid: "explorer", [setIdsField]: ["p2"] },
          kind,
          "other",
        ),
      );
      await drainStatsDeliveries();
      expect(await readProgress(hash, kind)).toMatchObject({ [collectedIdsField]: ["p1"] });
      expect(await readProgress(hash, kind, "other")).toMatchObject({
        [collectedIdsField]: ["p2"],
      });
      const table = kind === "map" ? "progress_sync_mutations" : "archive_progress_sync_mutations";
      expect(
        database.sqlite.prepare(`SELECT uid, mutation_id FROM ${table} ORDER BY uid`).all(),
      ).toEqual([
        { uid: "explorer", mutation_id: "device-mutation-1" },
        { uid: "other", mutation_id: "device-mutation-1" },
      ]);
    },
  );

  it.each(["map", "archive"] as const)(
    "replays the original %s result after later changes and rejects reused keys and stale clients",
    async (kind) => {
      const hash = await registerManifest(kind);
      const setIdsField = kind === "map" ? "setPointIds" : "setArchiveIds";
      const clearIdsField = kind === "map" ? "clearPointIds" : "clearArchiveIds";
      const collectedIdsField = kind === "map" ? "pointIds" : "archiveIds";
      const firstPatch = { [setIdsField]: ["p1"] };
      const first = await expectAcceptedSync(
        await syncProgress(hash, "offline-1", firstPatch, kind),
      );
      await drainStatsDeliveries();
      const secondPatch = {
        baseRevision: first.progress.revision,
        [clearIdsField]: ["p1"],
        [setIdsField]: ["p2"],
      };
      const second = await expectAcceptedSync(
        await syncProgress(hash, "offline-2", secondPatch, kind),
      );
      await drainStatsDeliveries();
      // Reconstruct the user object so the replay must come from persisted receipts.
      users.clear();
      const replay = await syncProgress(hash, "offline-1", firstPatch, kind);
      expect(replay.headers.get("x-progress-idempotent")).toBe("true");
      expect(await expectAcceptedSync(replay)).toEqual(first);
      expect(await readProgress(hash, kind)).toMatchObject({
        revision: second.progress.revision,
        [collectedIdsField]: ["p2"],
      });

      const reused = await syncProgress(hash, "offline-1", { [setIdsField]: ["p2"] }, kind);
      expect(reused.status).toBe(409);
      expect(await reused.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      const stale = await syncProgress(
        hash,
        "stale-client",
        { baseRevision: first.progress.revision, [setIdsField]: ["p1"] },
        kind,
      );
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        code: kind === "map" ? "PROGRESS_REVISION_CONFLICT" : "ARCHIVE_PROGRESS_REVISION_CONFLICT",
        details: { current: { revision: second.progress.revision, [collectedIdsField]: ["p2"] } },
      });
      const unchanged = await expectAcceptedSync(
        await syncProgress(
          hash,
          "already-collected",
          { baseRevision: second.progress.revision, [setIdsField]: ["p2"] },
          kind,
        ),
      );
      expect(unchanged).toMatchObject({
        unchanged: true,
        progress: { revision: second.progress.revision, [collectedIdsField]: ["p2"] },
      });
      await drainStatsDeliveries();
      const table = kind === "map" ? "progress_sync_mutations" : "archive_progress_sync_mutations";
      expect(
        database.sqlite
          .prepare(`SELECT mutation_id, result_version FROM ${table} ORDER BY mutation_id`)
          .all(),
      ).toEqual([
        { mutation_id: "already-collected", result_version: 2 },
        { mutation_id: "offline-1", result_version: 1 },
        { mutation_id: "offline-2", result_version: 2 },
      ]);
      expect(
        database.sqlite.prepare("SELECT progress_version FROM users WHERE uid = 'explorer'").get(),
      ).toEqual({ progress_version: kind === "map" ? 2 : 0 });
      expect(
        database.sqlite.prepare("SELECT count(*) AS count FROM progress_stats_outbox").get(),
      ).toEqual({ count: kind === "map" ? 2 : 0 });
    },
  );
});

describe("progress HTTP access and manifests", () => {
  it.each(["map", "archive"] as const)(
    "allows the same %s mutation to succeed after its missing index is registered",
    async (kind) => {
      const manifest = await buildManifestPayload(kind, ["p1", "p2"]);
      const hash = (
        "markerIndexHash" in manifest ? manifest.markerIndexHash : manifest.archiveIndexHash
      )!;
      const patch = { [kind === "map" ? "setPointIds" : "setArchiveIds"]: ["p1"] };
      const missing = await syncProgress(hash, "waiting-for-index", patch, kind);
      expect(missing.status).toBe(409);
      expect(await missing.json()).toMatchObject({
        code:
          kind === "map"
            ? "PROGRESS_MANIFEST_NOT_REGISTERED"
            : "ARCHIVE_PROGRESS_MANIFEST_NOT_REGISTERED",
      });
      await registerManifest(kind);
      await expectAcceptedSync(await syncProgress(hash, "waiting-for-index", patch, kind));
      await drainStatsDeliveries();
      expect(await readProgress(hash, kind)).toMatchObject({
        [kind === "map" ? "pointIds" : "archiveIds"]: ["p1"],
      });
    },
  );

  it("registers a map index and reads empty progress from durable manifest storage", async () => {
    const hash = await registerManifest();
    expect(
      database.sqlite.prepare("SELECT point_ids, point_count FROM progress_marker_manifests").all(),
    ).toEqual([{ point_ids: '["p1","p2"]', point_count: 2 }]);
    kv.clear();
    expect(await readProgress(`%20${hash.toUpperCase()}%20`)).toMatchObject({
      revision: "",
      pointIds: [],
      retainedPointIds: [],
      markerIndexHash: hash,
    });
    expect(
      database.sqlite
        .prepare("SELECT progress_version, progress_cloud_synced FROM users WHERE uid = 'explorer'")
        .get(),
    ).toEqual({ progress_version: 0, progress_cloud_synced: 0 });
  });

  it("keeps map, archive and public stats unavailable while stabilization is locked, including by default", async () => {
    for (const flag of [undefined, "true"]) {
      env.LOCK_PROGRESS_ENDPOINTS = flag;
      for (const [path, body] of endpoints) {
        const response = await request(path, body);
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toMatchObject({ code: "PROGRESS_TEMPORARILY_DISABLED" });
      }
    }
    expect(
      database.sqlite.prepare("SELECT progress_version FROM users WHERE uid = 'explorer'").get(),
    ).toEqual({ progress_version: 0 });
    expect(database.sqlite.prepare("SELECT * FROM progress_marker_manifests").all()).toEqual([]);
    expect(database.sqlite.prepare("SELECT * FROM archive_progress_manifests").all()).toEqual([]);
    expect(users.size).toBe(0);
  });

  it("requires a valid session for every personal progress operation", async () => {
    sessions.expired = { authorization: "Bearer no-such-session" };
    for (const user of [null, "expired"]) {
      for (const [path, body] of endpoints.filter(([path]) => path !== "/stats")) {
        const response = await request(path, body, user);
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toMatchObject({
          code: user ? "TOKEN_EXPIRED" : "SESSION_REQUIRED",
        });
      }
    }
    expect(users.size).toBe(0);
    expect(database.sqlite.prepare("SELECT * FROM progress_sync_mutations").all()).toEqual([]);
    expect(database.sqlite.prepare("SELECT * FROM archive_progress_sync_mutations").all()).toEqual(
      [],
    );
  });

  it.each(["map", "archive"] as const)(
    "registers a %s index idempotently and reads it from durable storage",
    async (kind) => {
      const archive = kind === "archive";
      const validHash = await registerManifest(kind);
      await registerManifest(kind);
      kv.clear();
      expect(await readProgress(validHash, kind)).toMatchObject({
        revision: "",
        [archive ? "archiveIds" : "pointIds"]: [],
      });
      expect(
        database.sqlite
          .prepare(
            `SELECT count(*) AS count FROM ${archive ? "archive_progress_manifests" : "progress_marker_manifests"}`,
          )
          .get(),
      ).toEqual({ count: 1 });
    },
  );
});

const endpoints: Array<[string, unknown?]> = [
  ["/manifest", {}],
  ["/state"],
  ["/sync", {}],
  ["/archive/manifest", {}],
  ["/archive/state"],
  ["/archive/sync", {}],
  ["/stats"],
];

// Cloudflare loopback and WorkerEntrypoint are runtime boundaries. The actual
// cache origin, auth, route, DO, repository and SQL code run without substitution.
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: ExecutionContext,
      readonly env: AppEnv["Bindings"],
    ) {}
  },
  exports: { PublicReadCache: { fetch: (request: Request) => publicCache.fetch(request) } },
}));
