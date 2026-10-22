import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import {
  createProgressFixture,
  createProgressState,
  FakeStorage,
  insertProgressManifest,
  type ProgressFixture,
} from "@/test/fixtures/progress";
import { insertUser } from "@/test/fixtures/users";

import { buildStatsCountsBase64, parseStatsCountsBase64 } from "./bitmap";
import { OEMStatsDO } from "./statsDo";
import { OEMUserDO } from "./userDo";

// The public stats route imports Workers service bindings; these cases never call it.
vi.mock("cloudflare:workers", () => ({ exports: {} }));

const databases: TestDatabase[] = [];
const fixtures: ProgressFixture[] = [];
function fixtureForTest(
  database: TestDatabase,
  uid = "A",
  statsFetch?: Fetcher["fetch"],
): ProgressFixture {
  const fixture = createProgressFixture(database, uid, statsFetch);
  fixtures.push(fixture);
  return fixture;
}
function databaseForTest(): TestDatabase {
  const database = createTestDatabase();
  databases.push(database);
  return database;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).flatMap((fixture) => fixture.state.waits));
  for (const database of databases.splice(0)) {
    database.close();
  }
  vi.restoreAllMocks();
});

function syncRequest(
  markerIndexHash: string,
  options: {
    mutationId: string;
    baseRevision?: string;
    setPointIds?: string[];
  },
): Request {
  return new Request("https://progress-user/sync?uid=B", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: options.baseRevision ?? "",
      markerIndexHash,
      clientMutationId: options.mutationId,
      setPointIds: options.setPointIds ?? [],
      clearPointIds: [],
      updatedAt: 1_700_000_000_000,
    }),
  });
}

function archiveSyncRequest(
  archiveIndexHash: string,
  options: {
    mutationId: string;
    baseRevision?: string;
    setArchiveIds?: string[];
    clearArchiveIds?: string[];
  },
): Request {
  return new Request("https://progress-user/archive/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: options.baseRevision ?? "",
      archiveIndexHash,
      clientMutationId: options.mutationId,
      setArchiveIds: options.setArchiveIds ?? [],
      clearArchiveIds: options.clearArchiveIds ?? [],
      updatedAt: 1_700_000_000_000,
    }),
  });
}

describe("OEMUserDO progress consistency", () => {
  it("keeps a low-cardinality completion event for successful requests", async () => {
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const database = databaseForTest();
    insertUser(database.sqlite, { uid: "A", uid_number: 100001 });
    const { request, markerIndexHash } = fixtureForTest(database);

    const response = await request(
      new Request(`https://progress-user/state?markerIndexHash=${markerIndexHash}`),
    );

    expect(response.status).toBe(200);
    expect(warningLog).toHaveBeenCalledWith(
      "[progress][sync] request completed",
      expect.objectContaining({
        operation: "state",
        status: 200,
        stage: "state_read",
      }),
    );
    const completion = warningLog.mock.calls.find(
      ([label]) => label === "[progress][sync] request completed",
    )?.[1];
    expect(completion).not.toHaveProperty("uid");
    expect(completion).not.toHaveProperty("clientMutationId");
  });

  it("acknowledges retained points in sync, state, unchanged responses, and idempotent replays", async () => {
    const database = databaseForTest();
    insertUser(database.sqlite, { uid: "A", uid_number: 100001 });
    const { request, markerIndexHash, state } = fixtureForTest(database);
    const firstRequest = {
      mutationId: "legacy-1",
      setPointIds: ["p1", " legacy-old ", "legacy-old"],
    };
    const firstResponse = await request(syncRequest(markerIndexHash, firstRequest));
    const first = (await firstResponse.json()) as {
      progress: { revision: string; retainedPointIds: string[] };
    };
    expect(firstResponse.status).toBe(200);
    expect(first.progress.retainedPointIds).toEqual(["legacy-old"]);
    expect(
      JSON.parse(
        String(
          database.sqlite.prepare("SELECT * FROM users WHERE uid='A'").get()
            ?.progress_retained_point_ids,
        ),
      ),
    ).toEqual(["legacy-old"]);

    const readResponse = await request(
      new Request(`https://progress-user/state?markerIndexHash=${markerIndexHash}`),
    );
    expect(await readResponse.json()).toMatchObject({
      progress: { pointIds: ["p1"], retainedPointIds: ["legacy-old"] },
    });
    const repeated = await request(
      syncRequest(markerIndexHash, {
        ...firstRequest,
        mutationId: "legacy-2",
        baseRevision: first.progress.revision,
      }),
    );
    expect(await repeated.json()).toMatchObject({
      unchanged: true,
      progress: { pointIds: ["p1"], retainedPointIds: ["legacy-old"] },
    });
    expect(
      database.sqlite.prepare("SELECT * FROM users WHERE uid='A'").get()?.progress_version,
    ).toBe(1);
    const replay = await request(syncRequest(markerIndexHash, firstRequest));
    expect(await replay.json()).toEqual(first);
    expect(replay.headers.get("x-progress-idempotent")).toBe("true");
    await Promise.all(state.waits);
  });

  it("returns authoritative retained acknowledgements in revision conflicts", async () => {
    const database = databaseForTest();
    insertUser(database.sqlite, { uid: "A", uid_number: 100001 });
    const { request, markerIndexHash, state } = fixtureForTest(database);
    await request(
      syncRequest(markerIndexHash, { mutationId: "first", setPointIds: ["p1", "legacy"] }),
    );
    const conflict = await request(
      syncRequest(markerIndexHash, { mutationId: "stale", setPointIds: ["p2"] }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "PROGRESS_REVISION_CONFLICT",
      details: { current: { pointIds: ["p1"], retainedPointIds: ["legacy"] } },
    });
    expect(
      database.sqlite.prepare("SELECT * FROM users WHERE uid='A'").get()?.progress_version,
    ).toBe(1);
    await Promise.all(state.waits);
  });

  it("reports removed source-manifest points separately without counting retained known IDs as active", async () => {
    const database = databaseForTest();
    const sourceHash = "b".repeat(64);
    insertUser(database.sqlite, { uid: "A", uid_number: 100001 });
    database.sqlite
      .prepare(`UPDATE users SET progress_version=1, progress_marker='Aw==',
      progress_marker_index_hash=?, progress_checksum=?, progress_point_count=2,
      progress_retained_point_ids=? WHERE uid='A'`)
      .run(sourceHash, "d".repeat(64), JSON.stringify(["legacy-old", "p2"]));
    const { request, markerIndexHash, state } = fixtureForTest(database);
    insertProgressManifest(database, sourceHash, ["p1", "removed"]);
    const response = await request(
      new Request(`https://progress-user/state?markerIndexHash=${markerIndexHash}`),
    );
    expect(await response.json()).toMatchObject({
      progress: {
        markerIndexHash: sourceHash,
        pointIds: ["p1"],
        retainedPointIds: ["legacy-old", "removed"],
      },
    });
    expect(
      database.sqlite.prepare("SELECT count(*) AS count FROM progress_sync_mutations").get()?.count,
    ).toBe(0);
    const migrated = await request(
      syncRequest(markerIndexHash, {
        mutationId: "migration",
        baseRevision: "d".repeat(64),
      }),
    );
    expect(migrated.status).toBe(200);
    expect(await migrated.json()).toMatchObject({
      progress: { markerIndexHash, retainedPointIds: ["legacy-old", "removed"] },
    });
    expect(
      JSON.parse(
        String(
          database.sqlite.prepare("SELECT * FROM users WHERE uid='A'").get()
            ?.progress_retained_point_ids,
        ),
      ),
    ).toEqual(["legacy-old", "p2", "removed"]);
    await Promise.all(state.waits);
  });

  it("keeps retained acknowledgements even for an empty bitmap state", async () => {
    const database = databaseForTest();
    insertUser(database.sqlite, { uid: "A", uid_number: 100001 });
    database.sqlite.exec(`UPDATE users SET progress_retained_point_ids='["legacy"]' WHERE uid='A'`);
    const { request, markerIndexHash } = fixtureForTest(database);
    const response = await request(
      new Request(`https://progress-user/state?markerIndexHash=${markerIndexHash}`),
    );
    expect(await response.json()).toMatchObject({
      progress: { markerIndexHash, pointIds: [], retainedPointIds: ["legacy"] },
    });
  });

  it("uses the named DO identity and ignores a forged URL uid", async () => {
    const database = databaseForTest();
    insertUser(database.sqlite, { uid: "A", uid_number: 100001 });
    insertUser(database.sqlite, { uid: "B", uid_number: 100002 });
    const { object, markerIndexHash, state } = fixtureForTest(database);

    const response = await object.fetch(
      syncRequest(markerIndexHash, {
        mutationId: "m1",
        setPointIds: ["p1"],
      }),
    );
    await Promise.all(state.waits);

    expect(response.status).toBe(200);
    expect(
      database.sqlite.prepare("SELECT * FROM users WHERE uid='A'").get()?.progress_version,
    ).toBe(1);
    expect(
      database.sqlite.prepare("SELECT * FROM users WHERE uid='B'").get()?.progress_version,
    ).toBe(0);
  });

  it("fails closed when the DO has no named identity", async () => {
    const database = databaseForTest();
    const { state } = createProgressState();
    const object = new OEMUserDO(state, createMockBindings({ DB: database.db }).bindings);
    const response = await object.fetch(
      new Request(`https://progress-user/state?markerIndexHash=${"a".repeat(64)}`),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "PROGRESS_DO_IDENTITY_MISSING" });
  });

  it("rolls back user, mutation, and outbox when a batch statement fails", async () => {
    const database = databaseForTest();
    insertUser(database.sqlite, { uid: "A", uid_number: 100001 });
    // Abort only after the initial UPDATE has changed the user inside the batch.
    database.sqlite
      .exec(`CREATE TRIGGER reject_progress_mutation BEFORE INSERT ON progress_sync_mutations
      WHEN (SELECT progress_version FROM users WHERE uid = NEW.uid) = 1
      BEGIN SELECT RAISE(ABORT, 'injected mutation failure after user update'); END`);
    const { request, markerIndexHash, state } = fixtureForTest(database);

    const response = await request(
      syncRequest(markerIndexHash, {
        mutationId: "m1",
        setPointIds: ["p1"],
      }),
    );
    await Promise.all(state.waits);

    expect(response.status).toBe(500);
    expect(
      database.sqlite.prepare("SELECT * FROM users WHERE uid='A'").get()?.progress_version,
    ).toBe(0);
    expect(
      database.sqlite.prepare("SELECT count(*) AS count FROM progress_sync_mutations").get()?.count,
    ).toBe(0);
    expect(database.sqlite.prepare("SELECT * FROM progress_stats_outbox").all()).toHaveLength(0);
  });

  it("returns the original M1 result after M2 without applying M1 twice", async () => {
    const database = databaseForTest();
    insertUser(database.sqlite, { uid: "A", uid_number: 100001 });
    const { request, markerIndexHash, state } = fixtureForTest(database);

    const first = await request(
      syncRequest(markerIndexHash, {
        mutationId: "m1",
        setPointIds: ["p1"],
      }),
    );
    const firstBody = await first.text();
    const firstRevision = (JSON.parse(firstBody) as { progress: { revision: string } }).progress
      .revision;
    const second = await request(
      syncRequest(markerIndexHash, {
        mutationId: "m2",
        baseRevision: firstRevision,
        setPointIds: ["p2"],
      }),
    );
    expect(second.status).toBe(200);

    const replay = await request(
      syncRequest(markerIndexHash, {
        mutationId: "m1",
        setPointIds: ["p1"],
      }),
    );
    await Promise.all(state.waits);

    expect(await replay.text()).toBe(firstBody);
    expect(replay.headers.get("x-progress-idempotent")).toBe("true");
    expect(
      database.sqlite.prepare("SELECT * FROM users WHERE uid='A'").get()?.progress_version,
    ).toBe(2);
    expect(
      database.sqlite.prepare("SELECT count(*) AS count FROM progress_sync_mutations").get()?.count,
    ).toBe(2);
    expect(database.sqlite.prepare("SELECT * FROM progress_stats_outbox").all()).toHaveLength(2);
  });

  it("does not wait for a slow Stats DO after the D1 batch commits", async () => {
    const database = databaseForTest();
    insertUser(database.sqlite, { uid: "A", uid_number: 100001 });
    let acknowledge!: (response: Response) => void;
    const statsNeverRespond = () =>
      new Promise<Response>((resolve) => {
        acknowledge = resolve;
      });
    const { request, markerIndexHash, state } = fixtureForTest(database, "A", statsNeverRespond);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      request(
        syncRequest(markerIndexHash, {
          mutationId: "m1",
          setPointIds: ["p1"],
        }),
      ),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), 100);
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }

    try {
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(200);
      expect(
        database.sqlite.prepare("SELECT * FROM users WHERE uid='A'").get()?.progress_version,
      ).toBe(1);
    } finally {
      acknowledge(Response.json({ applied: true }));
      await Promise.all(state.waits);
    }
  });
});

describe("OEMUserDO archive progress consistency", () => {
  it("syncs archive ids without creating map progress or stats events", async () => {
    const database = databaseForTest();
    insertUser(database.sqlite, { uid: "A", uid_number: 100001 });
    const { request, archiveIndexHash } = fixtureForTest(database);

    const syncResponse = await request(
      archiveSyncRequest(archiveIndexHash, {
        mutationId: "archive-m1",
        setArchiveIds: ["archive-a"],
      }),
    );
    expect(syncResponse.status).toBe(200);

    const stateResponse = await request(
      new Request(`https://progress-user/archive/state?archiveIndexHash=${archiveIndexHash}`),
    );
    expect(stateResponse.status).toBe(200);
    expect(await stateResponse.json()).toMatchObject({
      progress: {
        archiveIndexHash,
        archiveIds: ["archive-a"],
      },
    });
    expect(
      database.sqlite.prepare("SELECT * FROM user_archive_progress WHERE uid='A'").get()?.version,
    ).toBe(1);
    expect(
      database.sqlite.prepare("SELECT * FROM users WHERE uid='A'").get()?.progress_version,
    ).toBe(0);
    expect(database.sqlite.prepare("SELECT * FROM progress_stats_outbox").all()).toHaveLength(0);
  });

  it("replays an archive mutation idempotently and rejects a stale revision", async () => {
    const database = databaseForTest();
    insertUser(database.sqlite, { uid: "A", uid_number: 100001 });
    const { request, archiveIndexHash } = fixtureForTest(database);
    const firstRequest = archiveSyncRequest(archiveIndexHash, {
      mutationId: "archive-m1",
      setArchiveIds: ["archive-a"],
    });
    const first = await request(firstRequest);
    const firstBody = await first.text();
    const firstRevision = (JSON.parse(firstBody) as { progress: { revision: string } }).progress
      .revision;

    const replay = await request(
      archiveSyncRequest(archiveIndexHash, {
        mutationId: "archive-m1",
        setArchiveIds: ["archive-a"],
      }),
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-progress-idempotent")).toBe("true");
    expect(await replay.text()).toBe(firstBody);

    const second = await request(
      archiveSyncRequest(archiveIndexHash, {
        mutationId: "archive-m2",
        baseRevision: firstRevision,
        setArchiveIds: ["archive-b"],
      }),
    );
    expect(second.status).toBe(200);

    const conflict = await request(
      archiveSyncRequest(archiveIndexHash, {
        mutationId: "archive-m3",
        baseRevision: firstRevision,
        clearArchiveIds: ["archive-a"],
      }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "ARCHIVE_PROGRESS_REVISION_CONFLICT",
      details: { current: { archiveIds: ["archive-a", "archive-b"] } },
    });
  });
});

describe("OEMStatsDO event receipts", () => {
  const markerIndexHash = "a".repeat(64);
  const eventId = "b".repeat(64);
  const payload = {
    eventId,
    markerIndexHash,
    pointCount: 2,
    increments: [0],
    decrements: [],
    firstSync: true,
  };

  interface StatsFixture {
    object: OEMStatsDO;
    storage: FakeStorage;
  }

  function createStatsDo(storage = new FakeStorage(), database = databaseForTest()): StatsFixture {
    const state = createProgressState(markerIndexHash, storage);
    return {
      object: new OEMStatsDO(state.state, createMockBindings({ DB: database.db }).bindings),
      storage,
    };
  }

  it("deduplicates a retry after the first acknowledgement is lost", async () => {
    const { object, storage } = createStatsDo();
    const request = () =>
      new Request("https://progress-stats/apply", {
        method: "POST",
        body: JSON.stringify(payload),
      });

    expect((await object.fetch(request())).status).toBe(200);
    const replay = await object.fetch(request());
    expect(await replay.json()).toMatchObject({ ok: true, idempotent: true });

    const snapshot = await storage.get<{ counts: string; totalSyncedUsers: number }>(
      "stats:snapshot:v2",
    );
    expect(snapshot?.totalSyncedUsers).toBe(1);
    expect([...parseStatsCountsBase64(snapshot?.counts ?? "", 2)]).toEqual([1, 0]);
  });

  it("does not replace memory or storage when the transaction fails", async () => {
    const storage = new FakeStorage();
    storage.failNextTransaction = true;
    const { object } = createStatsDo(storage);
    const request = () =>
      new Request("https://progress-stats/apply", {
        method: "POST",
        body: JSON.stringify(payload),
      });

    expect((await object.fetch(request())).status).toBe(500);
    expect(await storage.get("stats:snapshot:v2")).toBeUndefined();
    expect((await object.fetch(request())).status).toBe(200);
    const snapshot = await storage.get<{ counts: string }>("stats:snapshot:v2");
    expect([...parseStatsCountsBase64(snapshot?.counts ?? "", 2)]).toEqual([1, 0]);
  });

  it("replaces a stale v2 DO snapshot with a newer authoritative v2 D1 rebuild", async () => {
    const storage = new FakeStorage();
    await storage.put("stats:snapshot:v2", {
      markerIndexHash,
      pointCount: 2,
      totalSyncedUsers: 7,
      counts: buildStatsCountsBase64(new Uint32Array([1, 0])),
      updatedAt: 100,
    });
    await storage.put("stats:d1:dirty:v2", true);
    const database = databaseForTest();
    database.sqlite
      .prepare(`INSERT INTO progress_stats_snapshots
      (marker_index_hash, point_count, total_synced_users, counts, updated_at, snapshot_version)
      VALUES (?, 2, 687, ?, 200, 2)`)
      .run(markerIndexHash, buildStatsCountsBase64(new Uint32Array([300, 20])));
    const { object } = createStatsDo(storage, database);

    const response = await object.fetch(
      new Request(`https://progress-stats/state?markerIndexHash=${markerIndexHash}`),
    );
    expect(await response.json()).toMatchObject({ totalSyncedUsers: 687, sampleSize: 687 });
    const stored = await storage.get<{ counts: string; totalSyncedUsers: number }>(
      "stats:snapshot:v2",
    );
    expect(stored?.totalSyncedUsers).toBe(687);
    expect([...parseStatsCountsBase64(stored?.counts ?? "", 2)]).toEqual([300, 20]);
    expect(await storage.get("stats:d1:dirty:v2")).toBeUndefined();
  });
});
