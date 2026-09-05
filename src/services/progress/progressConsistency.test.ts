import { describe, expect, it } from "vitest";
import { buildStatsCountsBase64, parseStatsCountsBase64 } from "./bitmap";
import type { ProgressDoEnv } from "./manifest";
import { OEMStatsDO } from "./statsDo";
import { OEMUserDO } from "./userDo";

type StoredUser = Record<string, unknown>;
type BoundStatement = { sql: string; values: unknown[] };

class FakeStatement {
  readonly values: unknown[];

  constructor(
    private readonly database: FakeD1,
    readonly sql: string,
    values: unknown[] = []
  ) {
    this.values = values;
  }

  bind(...values: unknown[]): FakeStatement {
    return new FakeStatement(this.database, this.sql, values);
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM progress_sync_mutations")) {
      const key = `${this.values[0]}:${this.values[1]}`;
      return (this.database.mutations.get(key) as T | undefined) ?? null;
    }
    if (this.sql.includes("FROM archive_progress_sync_mutations")) {
      const key = `${this.values[0]}:${this.values[1]}`;
      return (this.database.archiveMutations.get(key) as T | undefined) ?? null;
    }
    if (this.sql.includes("FROM user_archive_progress")) {
      return (this.database.archiveProgress.get(String(this.values[0])) as T | undefined) ?? null;
    }
    if (this.sql.includes("SELECT * FROM users")) {
      return (this.database.users.get(String(this.values[0])) as T | undefined) ?? null;
    }
    if (this.sql.includes("FROM progress_stats_snapshots")) {
      return (this.database.statsSnapshot as T | null) ?? null;
    }
    return null;
  }

  async all<T>(): Promise<D1Result<T>> {
    if (this.sql.includes("FROM progress_stats_outbox") && this.database.dispatchOutbox) {
      const uid = this.values.length >= 3 ? String(this.values[2]) : null;
      const limit = Number(this.values[1] ?? 100);
      const results = this.database.outbox
        .filter((event) => event.status === "pending" && (!uid || event.uid === uid))
        .sort((left, right) => Number(left.id) - Number(right.id))
        .slice(0, limit) as T[];
      return { success: true, results } as unknown as D1Result<T>;
    }
    return { success: true, results: [] } as unknown as D1Result<T>;
  }

  async run<T>(): Promise<D1Result<T>> {
    this.database.execute({ sql: this.sql, values: this.values });
    return { success: true } as unknown as D1Result<T>;
  }
}

class FakeD1 {
  users = new Map<string, StoredUser>();
  mutations = new Map<string, Record<string, unknown>>();
  archiveProgress = new Map<string, Record<string, unknown>>();
  archiveMutations = new Map<string, Record<string, unknown>>();
  outbox: Array<Record<string, unknown>> = [];
  statsSnapshot: Record<string, unknown> | null = null;
  failBatchAt: number | null = null;
  dispatchOutbox = false;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<D1Result[]> {
    const users = structuredClone(this.users);
    const mutations = structuredClone(this.mutations);
    const archiveProgress = structuredClone(this.archiveProgress);
    const archiveMutations = structuredClone(this.archiveMutations);
    const outbox = structuredClone(this.outbox);
    const original = {
      users: this.users,
      mutations: this.mutations,
      archiveProgress: this.archiveProgress,
      archiveMutations: this.archiveMutations,
      outbox: this.outbox
    };
    this.users = users;
    this.mutations = mutations;
    this.archiveProgress = archiveProgress;
    this.archiveMutations = archiveMutations;
    this.outbox = outbox;
    try {
      statements.forEach((statement, index) => {
        if (this.failBatchAt === index) throw new Error("injected D1 batch failure");
        this.execute(statement);
      });
    } catch (error) {
      this.users = original.users;
      this.mutations = original.mutations;
      this.archiveProgress = original.archiveProgress;
      this.archiveMutations = original.archiveMutations;
      this.outbox = original.outbox;
      throw error;
    }
    return statements.map(() => ({ success: true } as unknown as D1Result));
  }

  execute(statement: BoundStatement): void {
    const { sql, values } = statement;
    if (sql.includes("UPDATE users") && sql.includes("progress_version")) {
      const uid = String(values[0]);
      const user = this.users.get(uid);
      if (!user) return;
      Object.assign(user, {
        progress_version: values[1],
        progress_marker: values[2],
        progress_checksum: values[3],
        progress_marker_index_hash: values[4],
        progress_format_version: values[5],
        progress_bits_per_point: values[6],
        progress_point_count: values[7],
        progress_retained_point_ids: values[8],
        progress_updated_at: values[9],
        progress_last_mutation_id: values[10],
        progress_cloud_synced: values[11],
        progress_synced_at: values[12] ?? user.progress_synced_at
      });
      return;
    }
    if (sql.includes("INSERT INTO progress_sync_mutations")) {
      const key = `${values[0]}:${values[1]}`;
      if (this.mutations.has(key)) throw new Error("duplicate mutation");
      this.mutations.set(key, {
        request_hash: values[2],
        response_json: values[3],
        result_version: values[4],
        created_at: values[5]
      });
      return;
    }
    if (sql.includes("INSERT INTO user_archive_progress")) {
      const uid = String(values[0]);
      this.archiveProgress.set(uid, {
        version: values[1],
        marker: values[2],
        checksum: values[3],
        archive_index_hash: values[4],
        format_version: values[5],
        bits_per_archive: values[6],
        archive_count: values[7],
        retained_archive_ids: values[8],
        updated_at: values[9],
        last_mutation_id: values[10]
      });
      return;
    }
    if (sql.includes("INSERT INTO archive_progress_sync_mutations")) {
      const key = `${values[0]}:${values[1]}`;
      if (this.archiveMutations.has(key)) throw new Error("duplicate archive mutation");
      this.archiveMutations.set(key, {
        request_hash: values[2],
        response_json: values[3],
        result_version: values[4],
        created_at: values[5]
      });
      return;
    }
    if (sql.includes("INSERT INTO progress_stats_outbox")) {
      this.outbox.push({
        id: this.outbox.length + 1,
        event_id: values[0],
        uid: values[1],
        mutation_id: values[2],
        marker_index_hash: values[3],
        payload: values[4],
        status: "pending",
        attempts: 0,
        created_at: values[5]
      });
      return;
    }
    if (sql.includes("UPDATE progress_stats_outbox") && sql.includes("status = 'processed'")) {
      const event = this.outbox.find((candidate) => candidate.event_id === values[0]);
      if (event) event.status = "processed";
    }
  }
}

class FakeStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  failNextTransaction = false;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      let deleted = 0;
      keyOrKeys.forEach((key) => {
        if (this.values.delete(key)) deleted += 1;
      });
      return deleted;
    }
    return this.values.delete(keyOrKeys);
  }

  async list<T>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, options?.limit);
    return new Map(entries) as Map<string, T>;
  }

  async transaction<T>(closure: (transaction: FakeStorage) => Promise<T>): Promise<T> {
    if (this.failNextTransaction) {
      this.failNextTransaction = false;
      throw new Error("injected storage transaction failure");
    }
    const transaction = new FakeStorage();
    transaction.values = structuredClone(this.values);
    transaction.alarm = this.alarm;
    const result = await closure(transaction);
    this.values = transaction.values;
    this.alarm = transaction.alarm;
    return result;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(value: number | Date): Promise<void> {
    this.alarm = Number(value);
  }
}

function userRow(uid: string): StoredUser {
  return {
    uid,
    uid_number: 100001,
    uid_suffix: "AA",
    email: `${uid}@example.com`,
    password_hash: "",
    role: "n",
    avt: 0,
    nickname: uid,
    nickname_customized: 0,
    progress_version: 0,
    progress_marker: "",
    progress_checksum: "",
    progress_marker_index_hash: "",
    progress_format_version: 1,
    progress_bits_per_point: 1,
    progress_point_count: 0,
    progress_retained_point_ids: "[]",
    progress_updated_at: null,
    progress_last_mutation_id: null,
    progress_cloud_synced: 0,
    progress_synced_at: null,
    points: 0,
    karma: 0,
    created_at: "2026-01-01",
    last_active: "2026-01-01"
  };
}

function createState(name?: string, storage = new FakeStorage()): {
  state: DurableObjectState;
  waits: Promise<unknown>[];
  storage: FakeStorage;
} {
  const waits: Promise<unknown>[] = [];
  return {
    state: {
      id: { name },
      storage,
      waitUntil: (promise: Promise<unknown>) => waits.push(promise)
    } as unknown as DurableObjectState,
    waits,
    storage
  };
}

function createUserDo(
  database: FakeD1,
  uid = "A",
  statsFetch: () => Promise<Response> = async () => new Response("{}")
) {
  const markerIndexHash = "a".repeat(64);
  const manifest = JSON.stringify({
    markerIndexHash,
    formatVersion: 1,
    bitsPerPoint: 1,
    pointIds: ["p1", "p2"],
    pointCount: 2
  });
  const archiveIndexHash = "c".repeat(64);
  const archiveManifest = JSON.stringify({
    archiveIndexHash,
    formatVersion: 1,
    bitsPerArchive: 1,
    archiveIds: ["archive-a", "archive-b"],
    archiveCount: 2
  });
  const kv = {
    get: async (key: string) => key.includes("archive-manifest") ? archiveManifest : manifest,
    put: async () => undefined
  };
  const state = createState(uid);
  const env = {
    DB: database,
    OEM_KV: kv,
    OEM_STATS_DO: { getByName: () => ({ fetch: statsFetch }) }
  } as unknown as ProgressDoEnv;
  return { object: new OEMUserDO(state.state, env), markerIndexHash, archiveIndexHash, state, kv };
}

function syncRequest(markerIndexHash: string, options: {
  mutationId: string;
  baseRevision?: string;
  setPointIds?: string[];
}): Request {
  return new Request("https://progress-user/sync?uid=B", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: options.baseRevision ?? "",
      markerIndexHash,
      clientMutationId: options.mutationId,
      setPointIds: options.setPointIds ?? [],
      clearPointIds: [],
      updatedAt: 1_700_000_000_000
    })
  });
}

function archiveSyncRequest(archiveIndexHash: string, options: {
  mutationId: string;
  baseRevision?: string;
  setArchiveIds?: string[];
  clearArchiveIds?: string[];
}): Request {
  return new Request("https://progress-user/archive/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: options.baseRevision ?? "",
      archiveIndexHash,
      clientMutationId: options.mutationId,
      setArchiveIds: options.setArchiveIds ?? [],
      clearArchiveIds: options.clearArchiveIds ?? [],
      updatedAt: 1_700_000_000_000
    })
  });
}

describe("OEMUserDO progress consistency", () => {
  it("acknowledges retained points in sync, state, unchanged responses, and idempotent replays", async () => {
    const database = new FakeD1();
    database.users.set("A", userRow("A"));
    const { object, markerIndexHash, state } = createUserDo(database);
    const firstRequest = { mutationId: "legacy-1", setPointIds: ["p1", " legacy-old ", "legacy-old"] };
    const firstResponse = await object.fetch(syncRequest(markerIndexHash, firstRequest));
    const first = await firstResponse.json() as { progress: { revision: string; retainedPointIds: string[] } };
    expect(firstResponse.status).toBe(200);
    expect(first.progress.retainedPointIds).toEqual(["legacy-old"]);
    expect(JSON.parse(String(database.users.get("A")?.progress_retained_point_ids))).toEqual(["legacy-old"]);

    const readResponse = await object.fetch(new Request(`https://progress-user/state?markerIndexHash=${markerIndexHash}`));
    expect(await readResponse.json()).toMatchObject({
      progress: { pointIds: ["p1"], retainedPointIds: ["legacy-old"] }
    });
    const repeated = await object.fetch(syncRequest(markerIndexHash, {
      ...firstRequest, mutationId: "legacy-2", baseRevision: first.progress.revision
    }));
    expect(await repeated.json()).toMatchObject({
      unchanged: true, progress: { pointIds: ["p1"], retainedPointIds: ["legacy-old"] }
    });
    expect(database.users.get("A")?.progress_version).toBe(1);
    const replay = await object.fetch(syncRequest(markerIndexHash, firstRequest));
    expect(await replay.json()).toEqual(first);
    expect(replay.headers.get("x-progress-idempotent")).toBe("true");
    await Promise.all(state.waits);
  });

  it("returns authoritative retained acknowledgements in revision conflicts", async () => {
    const database = new FakeD1();
    database.users.set("A", userRow("A"));
    const { object, markerIndexHash, state } = createUserDo(database);
    await object.fetch(syncRequest(markerIndexHash, { mutationId: "first", setPointIds: ["p1", "legacy"] }));
    const conflict = await object.fetch(syncRequest(markerIndexHash, { mutationId: "stale", setPointIds: ["p2"] }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "PROGRESS_REVISION_CONFLICT",
      details: { current: { pointIds: ["p1"], retainedPointIds: ["legacy"] } }
    });
    expect(database.users.get("A")?.progress_version).toBe(1);
    await Promise.all(state.waits);
  });

  it("reports removed source-manifest points separately without counting retained known IDs as active", async () => {
    const database = new FakeD1();
    const sourceHash = "b".repeat(64);
    database.users.set("A", {
      ...userRow("A"), progress_version: 1, progress_marker: "Aw==",
      progress_marker_index_hash: sourceHash, progress_checksum: "d".repeat(64),
      progress_point_count: 2, progress_retained_point_ids: JSON.stringify(["legacy-old", "p2"])
    });
    const { object, markerIndexHash, kv, state } = createUserDo(database);
    const getDefault = kv.get;
    kv.get = async (key: string) => key.endsWith(sourceHash) ? JSON.stringify({
      markerIndexHash: sourceHash, formatVersion: 1, bitsPerPoint: 1,
      pointIds: ["p1", "removed"], pointCount: 2
    }) : getDefault(key);
    const response = await object.fetch(new Request(`https://progress-user/state?markerIndexHash=${markerIndexHash}`));
    expect(await response.json()).toMatchObject({
      progress: { markerIndexHash: sourceHash, pointIds: ["p1"], retainedPointIds: ["legacy-old", "removed"] }
    });
    expect(database.mutations.size).toBe(0);
    const migrated = await object.fetch(syncRequest(markerIndexHash, {
      mutationId: "migration", baseRevision: "d".repeat(64)
    }));
    expect(migrated.status).toBe(200);
    expect(await migrated.json()).toMatchObject({
      progress: { markerIndexHash, retainedPointIds: ["legacy-old", "removed"] }
    });
    expect(JSON.parse(String(database.users.get("A")?.progress_retained_point_ids)))
      .toEqual(["legacy-old", "p2", "removed"]);
    await Promise.all(state.waits);
  });

  it("keeps retained acknowledgements even for an empty bitmap state", async () => {
    const database = new FakeD1();
    database.users.set("A", { ...userRow("A"), progress_retained_point_ids: '["legacy"]' });
    const { object, markerIndexHash } = createUserDo(database);
    const response = await object.fetch(new Request(`https://progress-user/state?markerIndexHash=${markerIndexHash}`));
    expect(await response.json()).toMatchObject({
      progress: { markerIndexHash, pointIds: [], retainedPointIds: ["legacy"] }
    });
  });

  it("uses the named DO identity and ignores a forged URL uid", async () => {
    const database = new FakeD1();
    database.users.set("A", userRow("A"));
    database.users.set("B", userRow("B"));
    const { object, markerIndexHash, state } = createUserDo(database);

    const response = await object.fetch(syncRequest(markerIndexHash, {
      mutationId: "m1",
      setPointIds: ["p1"]
    }));
    await Promise.all(state.waits);

    expect(response.status).toBe(200);
    expect(database.users.get("A")?.progress_version).toBe(1);
    expect(database.users.get("B")?.progress_version).toBe(0);
  });

  it("fails closed when the DO has no named identity", async () => {
    const database = new FakeD1();
    const { state } = createState();
    const object = new OEMUserDO(state, { DB: database } as unknown as ProgressDoEnv);
    const response = await object.fetch(new Request(`https://progress-user/state?markerIndexHash=${"a".repeat(64)}`));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "PROGRESS_DO_IDENTITY_MISSING" });
  });

  it("rolls back user, mutation, and outbox when a batch statement fails", async () => {
    const database = new FakeD1();
    database.users.set("A", userRow("A"));
    database.failBatchAt = 1;
    const { object, markerIndexHash, state } = createUserDo(database);

    const response = await object.fetch(syncRequest(markerIndexHash, {
      mutationId: "m1",
      setPointIds: ["p1"]
    }));
    await Promise.all(state.waits);

    expect(response.status).toBe(500);
    expect(database.users.get("A")?.progress_version).toBe(0);
    expect(database.mutations.size).toBe(0);
    expect(database.outbox).toHaveLength(0);
  });

  it("returns the original M1 result after M2 without applying M1 twice", async () => {
    const database = new FakeD1();
    database.users.set("A", userRow("A"));
    const { object, markerIndexHash, state } = createUserDo(database);

    const first = await object.fetch(syncRequest(markerIndexHash, {
      mutationId: "m1",
      setPointIds: ["p1"]
    }));
    const firstBody = await first.text();
    const firstRevision = (JSON.parse(firstBody) as { progress: { revision: string } }).progress.revision;
    const second = await object.fetch(syncRequest(markerIndexHash, {
      mutationId: "m2",
      baseRevision: firstRevision,
      setPointIds: ["p2"]
    }));
    expect(second.status).toBe(200);

    const replay = await object.fetch(syncRequest(markerIndexHash, {
      mutationId: "m1",
      setPointIds: ["p1"]
    }));
    await Promise.all(state.waits);

    expect(await replay.text()).toBe(firstBody);
    expect(replay.headers.get("x-progress-idempotent")).toBe("true");
    expect(database.users.get("A")?.progress_version).toBe(2);
    expect(database.mutations.size).toBe(2);
    expect(database.outbox).toHaveLength(2);
  });

  it("does not wait for a slow Stats DO after the D1 batch commits", async () => {
    const database = new FakeD1();
    database.users.set("A", userRow("A"));
    database.dispatchOutbox = true;
    const statsNeverRespond = () => new Promise<Response>(() => undefined);
    const { object, markerIndexHash } = createUserDo(database, "A", statsNeverRespond);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      object.fetch(syncRequest(markerIndexHash, {
        mutationId: "m1",
        setPointIds: ["p1"]
      })),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), 100);
      })
    ]);
    if (timeout) clearTimeout(timeout);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
    expect(database.users.get("A")?.progress_version).toBe(1);
  });
});

describe("OEMUserDO archive progress consistency", () => {
  it("syncs archive ids without creating map progress or stats events", async () => {
    const database = new FakeD1();
    database.users.set("A", userRow("A"));
    const { object, archiveIndexHash } = createUserDo(database);

    const syncResponse = await object.fetch(archiveSyncRequest(archiveIndexHash, {
      mutationId: "archive-m1",
      setArchiveIds: ["archive-a"]
    }));
    expect(syncResponse.status).toBe(200);

    const stateResponse = await object.fetch(new Request(
      `https://progress-user/archive/state?archiveIndexHash=${archiveIndexHash}`
    ));
    expect(stateResponse.status).toBe(200);
    expect(await stateResponse.json()).toMatchObject({
      progress: {
        archiveIndexHash,
        archiveIds: ["archive-a"]
      }
    });
    expect(database.archiveProgress.get("A")?.version).toBe(1);
    expect(database.users.get("A")?.progress_version).toBe(0);
    expect(database.outbox).toHaveLength(0);
  });

  it("replays an archive mutation idempotently and rejects a stale revision", async () => {
    const database = new FakeD1();
    database.users.set("A", userRow("A"));
    const { object, archiveIndexHash } = createUserDo(database);
    const firstRequest = archiveSyncRequest(archiveIndexHash, {
      mutationId: "archive-m1",
      setArchiveIds: ["archive-a"]
    });
    const first = await object.fetch(firstRequest);
    const firstBody = await first.text();
    const firstRevision = (JSON.parse(firstBody) as { progress: { revision: string } }).progress.revision;

    const replay = await object.fetch(archiveSyncRequest(archiveIndexHash, {
      mutationId: "archive-m1",
      setArchiveIds: ["archive-a"]
    }));
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-progress-idempotent")).toBe("true");
    expect(await replay.text()).toBe(firstBody);

    const second = await object.fetch(archiveSyncRequest(archiveIndexHash, {
      mutationId: "archive-m2",
      baseRevision: firstRevision,
      setArchiveIds: ["archive-b"]
    }));
    expect(second.status).toBe(200);

    const conflict = await object.fetch(archiveSyncRequest(archiveIndexHash, {
      mutationId: "archive-m3",
      baseRevision: firstRevision,
      clearArchiveIds: ["archive-a"]
    }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "ARCHIVE_PROGRESS_REVISION_CONFLICT",
      details: { current: { archiveIds: ["archive-a", "archive-b"] } }
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
    firstSync: true
  };

  function createStatsDo(storage = new FakeStorage(), database = new FakeD1()) {
    const state = createState(markerIndexHash, storage);
    return {
      object: new OEMStatsDO(state.state, { DB: database } as unknown as ProgressDoEnv),
      storage
    };
  }

  it("deduplicates a retry after the first acknowledgement is lost", async () => {
    const { object, storage } = createStatsDo();
    const request = () => new Request("https://progress-stats/apply", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    expect((await object.fetch(request())).status).toBe(200);
    const replay = await object.fetch(request());
    expect(await replay.json()).toMatchObject({ ok: true, idempotent: true });

    const snapshot = await storage.get<{ counts: string; totalSyncedUsers: number }>("stats:snapshot:v2");
    expect(snapshot?.totalSyncedUsers).toBe(1);
    expect([...parseStatsCountsBase64(snapshot?.counts ?? "", 2)]).toEqual([1, 0]);
  });

  it("does not replace memory or storage when the transaction fails", async () => {
    const storage = new FakeStorage();
    storage.failNextTransaction = true;
    const { object } = createStatsDo(storage);
    const request = () => new Request("https://progress-stats/apply", {
      method: "POST",
      body: JSON.stringify(payload)
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
      updatedAt: 100
    });
    await storage.put("stats:d1:dirty:v2", true);
    const database = new FakeD1();
    database.statsSnapshot = {
      marker_index_hash: markerIndexHash,
      point_count: 2,
      total_synced_users: 687,
      counts: buildStatsCountsBase64(new Uint32Array([300, 20])),
      updated_at: 200
    };
    const { object } = createStatsDo(storage, database);

    const response = await object.fetch(new Request(
      `https://progress-stats/state?markerIndexHash=${markerIndexHash}`
    ));
    expect(await response.json()).toMatchObject({ totalSyncedUsers: 687, sampleSize: 687 });
    const stored = await storage.get<{ counts: string; totalSyncedUsers: number }>("stats:snapshot:v2");
    expect(stored?.totalSyncedUsers).toBe(687);
    expect([...parseStatsCountsBase64(stored?.counts ?? "", 2)]).toEqual([300, 20]);
    expect(await storage.get("stats:d1:dirty:v2")).toBeUndefined();
  });
});
