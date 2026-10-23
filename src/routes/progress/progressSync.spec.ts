import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildManifestPayload,
  createProgressHttpFixture,
  type ProgressHttpFixture,
} from "@/test/fixtures/progressHttp";
import type { AppEnv } from "@/types/app";
let fixture: ProgressHttpFixture;
beforeEach(() => {
  fixture = createProgressHttpFixture();
});
afterEach(async () => {
  await fixture.drainStatsDeliveries();
  vi.restoreAllMocks();
  fixture.database.close();
});

describe("persisted progress HTTP sync", () => {
  it("restores collected archives when their index entries return, clears retained archives, and leaves map progress untouched", async () => {
    const mapHash = await fixture.registerManifest();
    await fixture.expectAcceptedSync(
      await fixture.syncProgress(mapHash, "map-collection", { setPointIds: ["p2"] }),
    );
    await fixture.drainStatsDeliveries();
    const mapBefore = await fixture.readProgress(mapHash);
    const original = await fixture.registerManifest("archive", ["p1", "p2"]);
    const first = await fixture.expectAcceptedSync(
      await fixture.syncProgress(
        original,
        "archive-collection",
        { setArchiveIds: ["p1", "p2", "offline-old"] },
        "archive",
      ),
    );
    const reduced = await fixture.registerManifest("archive", ["p2", "p3"]);
    fixture.kv.clear();
    const projected = await fixture.readProgress(reduced, "archive");
    expect(projected).toMatchObject({ archiveIndexHash: reduced, archiveIds: ["p2"] });
    // Reading a new index projects progress without committing a migration.
    expect(
      fixture.database.sqlite
        .prepare("SELECT version, checksum FROM user_archive_progress WHERE uid = 'explorer'")
        .get(),
    ).toEqual({ version: 1, checksum: first.progress.revision });
    await fixture.expectAcceptedSync(
      await fixture.syncProgress(
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
    expect(await fixture.readProgress(reduced, "archive")).toMatchObject({
      archiveIds: ["p2", "p3"],
    });
    expect(
      fixture.database.sqlite
        .prepare("SELECT retained_archive_ids FROM user_archive_progress WHERE uid = 'explorer'")
        .get(),
    ).toEqual({ retained_archive_ids: '["p1"]' });
    const expanded = await fixture.registerManifest("archive", ["p1", "p2", "p3"]);
    const restored = await fixture.readProgress(expanded, "archive");
    expect(restored).toMatchObject({ archiveIds: ["p1", "p2", "p3"] });
    await fixture.expectAcceptedSync(
      await fixture.syncProgress(
        expanded,
        "archive-return",
        { baseRevision: restored.revision },
        "archive",
      ),
    );
    fixture.users.clear();
    fixture.kv.clear();
    expect(await fixture.readProgress(expanded, "archive")).toMatchObject({
      archiveIds: ["p1", "p2", "p3"],
    });
    expect(
      fixture.database.sqlite
        .prepare("SELECT retained_archive_ids FROM user_archive_progress WHERE uid = 'explorer'")
        .get(),
    ).toEqual({ retained_archive_ids: "[]" });
    expect(await fixture.readProgress(mapHash)).toEqual(mapBefore);
    expect(
      fixture.database.sqlite.prepare("SELECT mutation_id FROM progress_stats_outbox").all(),
    ).toEqual([{ mutation_id: "map-collection" }]);
  });

  it("keeps removed map points and offline unknown points acknowledged when the map index changes", async () => {
    const original = await fixture.registerManifest();
    const collected = await fixture.expectAcceptedSync(
      await fixture.syncProgress(original, "collected-before-map-update", {
        setPointIds: ["p1", "p2", "offline-old"],
      }),
    );
    await fixture.drainStatsDeliveries();
    const reduced = await fixture.registerManifest("map", ["p2", "p3"]);
    fixture.kv.clear();
    expect(await fixture.readProgress(reduced)).toMatchObject({
      revision: collected.progress.revision,
      markerIndexHash: original,
      pointIds: ["p2"],
      retainedPointIds: ["offline-old", "p1"],
    });
    expect(
      fixture.database.sqlite
        .prepare("SELECT progress_version FROM users WHERE uid = 'explorer'")
        .get(),
    ).toEqual({ progress_version: 1 });
    const migrated = await fixture.expectAcceptedSync(
      await fixture.syncProgress(reduced, "new-map", {
        baseRevision: collected.progress.revision,
        setPointIds: ["p3"],
      }),
    );
    await fixture.drainStatsDeliveries();
    fixture.users.clear();
    fixture.kv.clear();
    expect(await fixture.readProgress(reduced)).toMatchObject({
      revision: migrated.progress.revision,
      markerIndexHash: reduced,
      pointIds: ["p2", "p3"],
      retainedPointIds: ["offline-old", "p1"],
    });
    const stale = await fixture.syncProgress(reduced, "stale-new-map", { setPointIds: ["p1"] });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      details: { current: { pointIds: ["p2", "p3"], retainedPointIds: ["offline-old", "p1"] } },
    });
  });

  it("acknowledges an additional offline point without changing the public sample or known collections", async () => {
    const hash = await fixture.registerManifest();
    const first = await fixture.expectAcceptedSync(
      await fixture.syncProgress(hash, "known-point", { setPointIds: ["p1"] }),
    );
    await fixture.drainStatsDeliveries();
    const saved = await fixture.expectAcceptedSync(
      await fixture.syncProgress(hash, "offline-point", {
        baseRevision: first.progress.revision,
        setPointIds: ["offline-future"],
        clearPointIds: ["never-collected"],
      }),
    );
    await fixture.drainStatsDeliveries();
    fixture.users.clear();
    expect(await fixture.readProgress(hash)).toMatchObject({
      revision: saved.progress.revision,
      pointIds: ["p1"],
      retainedPointIds: ["offline-future"],
    });
    expect(
      fixture.database.sqlite.prepare("SELECT count(*) AS count FROM progress_stats_outbox").get(),
    ).toEqual({ count: 1 });
    const result = await fixture.readPublicStats(hash);
    expect(result.body).toMatchObject({ sampleSize: 1, totalSyncedUsers: 1 });
    expect(result.counts).toEqual([1, 0]);
  });

  it.each(["map", "archive"] as const)(
    "rolls back all %s writes on database failure and lets the identical mutation succeed on retry",
    async (kind) => {
      const hash = await fixture.registerManifest(kind);
      const table = kind === "map" ? "progress_stats_outbox" : "archive_progress_sync_mutations";
      // Fail a later write in a real SQLite transaction, after progress was written.
      fixture.database.sqlite
        .exec(`CREATE TEMP TRIGGER unavailable_sync_storage BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`);
      const patch = { [kind === "map" ? "setPointIds" : "setArchiveIds"]: ["p1"] };
      const failed = await fixture.syncProgress(hash, "retry-after-failure", patch, kind);
      expect(failed.status).toBe(500);
      expect(failed.headers.get("cache-control")).toBe("private, no-store");
      expect(await failed.json()).toMatchObject({ code: "PROGRESS_INTERNAL_ERROR" });
      expect(await fixture.readProgress(hash, kind)).toMatchObject({
        revision: "",
        [kind === "map" ? "pointIds" : "archiveIds"]: [],
      });
      for (const emptyTable of [
        "progress_sync_mutations",
        "archive_progress_sync_mutations",
        "progress_stats_outbox",
        "user_archive_progress",
      ]) {
        expect(fixture.database.sqlite.prepare(`SELECT * FROM ${emptyTable}`).all()).toEqual([]);
      }
      expect(
        fixture.database.sqlite
          .prepare(
            "SELECT progress_version, progress_cloud_synced, progress_last_mutation_id FROM users WHERE uid = 'explorer'",
          )
          .get(),
      ).toEqual({ progress_version: 0, progress_cloud_synced: 0, progress_last_mutation_id: null });
      fixture.database.sqlite.exec("DROP TRIGGER unavailable_sync_storage");
      await fixture.expectAcceptedSync(
        await fixture.syncProgress(hash, "retry-after-failure", patch, kind),
      );
      await fixture.drainStatsDeliveries();
      expect(await fixture.readProgress(hash, kind)).toMatchObject({
        [kind === "map" ? "pointIds" : "archiveIds"]: ["p1"],
      });
    },
  );

  it.each(["map", "archive"] as const)(
    "allows only one of two %s writes based on the same revision",
    async (kind) => {
      const hash = await fixture.registerManifest(kind);
      const setIdsField = kind === "map" ? "setPointIds" : "setArchiveIds";
      const collectedIdsField = kind === "map" ? "pointIds" : "archiveIds";
      const responses = await Promise.all([
        fixture.syncProgress(hash, "phone", { [setIdsField]: ["p1"] }, kind),
        fixture.syncProgress(hash, "laptop", { [setIdsField]: ["p2"] }, kind),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const winner = responses.findIndex((response) => response.status === 200);
      const saved = await fixture.expectAcceptedSync(responses[winner]);
      expect(await responses[1 - winner].json()).toMatchObject({
        details: {
          current: {
            revision: saved.progress.revision,
            [collectedIdsField]: [winner === 0 ? "p1" : "p2"],
          },
        },
      });
      expect(await fixture.readProgress(hash, kind)).toMatchObject({
        revision: saved.progress.revision,
        [collectedIdsField]: [winner === 0 ? "p1" : "p2"],
      });
      await fixture.drainStatsDeliveries();
    },
  );

  it.each(["map", "archive"] as const)(
    "isolates %s progress and mutation IDs by authenticated owner despite a forged identity",
    async (kind) => {
      const hash = await fixture.registerManifest(kind);
      const setIdsField = kind === "map" ? "setPointIds" : "setArchiveIds";
      const collectedIdsField = kind === "map" ? "pointIds" : "archiveIds";
      await fixture.expectAcceptedSync(
        await fixture.syncProgress(
          hash,
          "device-mutation-1",
          { uid: "other", [setIdsField]: ["p1"] },
          kind,
        ),
      );
      await fixture.drainStatsDeliveries();
      expect(await fixture.readProgress(hash, kind, "other")).toMatchObject({
        revision: "",
        [collectedIdsField]: [],
      });
      await fixture.expectAcceptedSync(
        await fixture.syncProgress(
          hash,
          "device-mutation-1",
          { uid: "explorer", [setIdsField]: ["p2"] },
          kind,
          "other",
        ),
      );
      await fixture.drainStatsDeliveries();
      expect(await fixture.readProgress(hash, kind)).toMatchObject({ [collectedIdsField]: ["p1"] });
      expect(await fixture.readProgress(hash, kind, "other")).toMatchObject({
        [collectedIdsField]: ["p2"],
      });
      const table = kind === "map" ? "progress_sync_mutations" : "archive_progress_sync_mutations";
      expect(
        fixture.database.sqlite.prepare(`SELECT uid, mutation_id FROM ${table} ORDER BY uid`).all(),
      ).toEqual([
        { uid: "explorer", mutation_id: "device-mutation-1" },
        { uid: "other", mutation_id: "device-mutation-1" },
      ]);
    },
  );

  it.each(["map", "archive"] as const)(
    "replays the original %s result after later changes and rejects reused keys and stale clients",
    async (kind) => {
      const hash = await fixture.registerManifest(kind);
      const setIdsField = kind === "map" ? "setPointIds" : "setArchiveIds";
      const clearIdsField = kind === "map" ? "clearPointIds" : "clearArchiveIds";
      const collectedIdsField = kind === "map" ? "pointIds" : "archiveIds";
      const firstPatch = { [setIdsField]: ["p1"] };
      const first = await fixture.expectAcceptedSync(
        await fixture.syncProgress(hash, "offline-1", firstPatch, kind),
      );
      await fixture.drainStatsDeliveries();
      const secondPatch = {
        baseRevision: first.progress.revision,
        [clearIdsField]: ["p1"],
        [setIdsField]: ["p2"],
      };
      const second = await fixture.expectAcceptedSync(
        await fixture.syncProgress(hash, "offline-2", secondPatch, kind),
      );
      await fixture.drainStatsDeliveries();
      // Reconstruct the user object so the replay must come from persisted receipts.
      fixture.users.clear();
      const replay = await fixture.syncProgress(hash, "offline-1", firstPatch, kind);
      expect(replay.headers.get("x-progress-idempotent")).toBe("true");
      expect(await fixture.expectAcceptedSync(replay)).toEqual(first);
      expect(await fixture.readProgress(hash, kind)).toMatchObject({
        revision: second.progress.revision,
        [collectedIdsField]: ["p2"],
      });

      const reused = await fixture.syncProgress(hash, "offline-1", { [setIdsField]: ["p2"] }, kind);
      expect(reused.status).toBe(409);
      expect(await reused.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      const stale = await fixture.syncProgress(
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
      const unchanged = await fixture.expectAcceptedSync(
        await fixture.syncProgress(
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
      await fixture.drainStatsDeliveries();
      const table = kind === "map" ? "progress_sync_mutations" : "archive_progress_sync_mutations";
      expect(
        fixture.database.sqlite
          .prepare(`SELECT mutation_id, result_version FROM ${table} ORDER BY mutation_id`)
          .all(),
      ).toEqual([
        { mutation_id: "already-collected", result_version: 2 },
        { mutation_id: "offline-1", result_version: 1 },
        { mutation_id: "offline-2", result_version: 2 },
      ]);
      expect(
        fixture.database.sqlite
          .prepare("SELECT progress_version FROM users WHERE uid = 'explorer'")
          .get(),
      ).toEqual({ progress_version: kind === "map" ? 2 : 0 });
      expect(
        fixture.database.sqlite
          .prepare("SELECT count(*) AS count FROM progress_stats_outbox")
          .get(),
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
      const missing = await fixture.syncProgress(hash, "waiting-for-index", patch, kind);
      expect(missing.status).toBe(409);
      expect(await missing.json()).toMatchObject({
        code:
          kind === "map"
            ? "PROGRESS_MANIFEST_NOT_REGISTERED"
            : "ARCHIVE_PROGRESS_MANIFEST_NOT_REGISTERED",
      });
      await fixture.registerManifest(kind);
      await fixture.expectAcceptedSync(
        await fixture.syncProgress(hash, "waiting-for-index", patch, kind),
      );
      await fixture.drainStatsDeliveries();
      expect(await fixture.readProgress(hash, kind)).toMatchObject({
        [kind === "map" ? "pointIds" : "archiveIds"]: ["p1"],
      });
    },
  );

  it("registers a map index and reads empty progress from durable manifest storage", async () => {
    const hash = await fixture.registerManifest();
    expect(
      fixture.database.sqlite
        .prepare("SELECT point_ids, point_count FROM progress_marker_manifests")
        .all(),
    ).toEqual([{ point_ids: '["p1","p2"]', point_count: 2 }]);
    fixture.kv.clear();
    expect(await fixture.readProgress(`%20${hash.toUpperCase()}%20`)).toMatchObject({
      revision: "",
      pointIds: [],
      retainedPointIds: [],
      markerIndexHash: hash,
    });
    expect(
      fixture.database.sqlite
        .prepare("SELECT progress_version, progress_cloud_synced FROM users WHERE uid = 'explorer'")
        .get(),
    ).toEqual({ progress_version: 0, progress_cloud_synced: 0 });
  });

  it("keeps map, archive and public stats unavailable while stabilization is locked, including by default", async () => {
    for (const flag of [undefined, "true"]) {
      fixture.env.LOCK_PROGRESS_ENDPOINTS = flag;
      for (const [path, body] of endpoints) {
        const response = await fixture.request(path, body);
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toMatchObject({ code: "PROGRESS_TEMPORARILY_DISABLED" });
      }
    }
    expect(
      fixture.database.sqlite
        .prepare("SELECT progress_version FROM users WHERE uid = 'explorer'")
        .get(),
    ).toEqual({ progress_version: 0 });
    expect(
      fixture.database.sqlite.prepare("SELECT * FROM progress_marker_manifests").all(),
    ).toEqual([]);
    expect(
      fixture.database.sqlite.prepare("SELECT * FROM archive_progress_manifests").all(),
    ).toEqual([]);
    expect(fixture.users.size).toBe(0);
  });

  it("requires a valid session for every personal progress operation", async () => {
    fixture.sessions.expired = { authorization: "Bearer no-such-session" };
    for (const user of [null, "expired"]) {
      for (const [path, body] of endpoints.filter(([path]) => path !== "/stats")) {
        const response = await fixture.request(path, body, user);
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toMatchObject({
          code: user ? "TOKEN_EXPIRED" : "SESSION_REQUIRED",
        });
      }
    }
    expect(fixture.users.size).toBe(0);
    expect(fixture.database.sqlite.prepare("SELECT * FROM progress_sync_mutations").all()).toEqual(
      [],
    );
    expect(
      fixture.database.sqlite.prepare("SELECT * FROM archive_progress_sync_mutations").all(),
    ).toEqual([]);
  });

  it.each(["map", "archive"] as const)(
    "registers a %s index idempotently and reads it from durable storage",
    async (kind) => {
      const archive = kind === "archive";
      const validHash = await fixture.registerManifest(kind);
      await fixture.registerManifest(kind);
      fixture.kv.clear();
      expect(await fixture.readProgress(validHash, kind)).toMatchObject({
        revision: "",
        [archive ? "archiveIds" : "pointIds"]: [],
      });
      expect(
        fixture.database.sqlite
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
  exports: { PublicReadCache: { fetch: (request: Request) => fixture.publicCache.fetch(request) } },
}));
