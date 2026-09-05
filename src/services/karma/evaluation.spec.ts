import type { Redis } from "@upstash/redis";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as rules from "../../lib/karma/rules";
import { SqliteD1 } from "../../test/sqliteD1";
import { UGC_COMPETING_INDEXES_SQL } from "../../test/ugcIndexes";
import { evaluateKarmaBatch, evaluateKarmaIfDue } from "./evaluation";

const LEASE_KEY = "karma:evaluation:v2:lease";
const CYCLE_KEY = "karma:evaluation:v2:cycle";
const START = Date.parse("2026-09-05T12:00:00Z");
const INTERVAL = 12 * 60 * 60 * 1000;

class MemoryRedis {
  readonly records = new Map<string, { value: unknown; expiresAt?: number }>();
  readonly redis = this as unknown as Redis;
  beforeSave?: () => void;

  async get<Result>(key: string): Promise<Result | null> {
    const record = this.records.get(key);
    if (record?.expiresAt !== undefined && record.expiresAt <= Date.now()) {
      this.records.delete(key);
      return null;
    }
    return (record?.value as Result | undefined) ?? null;
  }

  async set(key: string, value: unknown, options: { nx?: boolean; ex?: number } = {}): Promise<"OK" | null> {
    if (options.nx && await this.get(key) !== null) return null;
    this.records.set(key, { value, expiresAt: options.ex ? Date.now() + options.ex * 1000 : undefined });
    return "OK";
  }

  async eval(script: string, keys: string[], args: unknown[]): Promise<number> {
    if (script.includes("'SET'")) this.beforeSave?.();
    if (await this.get(keys[0]!) !== args[0]) return 0;
    if (script.includes("'SET'")) {
      this.records.set(keys[1]!, { value: JSON.parse(String(args[1])) });
    } else if (script.includes("'EXPIRE'")) {
      this.records.set(keys[0]!, { value: args[0], expiresAt: Date.now() + Number(args[1]) * 1000 });
    } else {
      this.records.delete(keys[0]!);
    }
    return 1;
  }
}

describe("12-hour resumable karma evaluation", () => {
  let database: SqliteD1;
  let redis: MemoryRedis;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
    vi.spyOn(rules, "getKarmaEvaluationBatchSize").mockReturnValue(3);
    database = new SqliteD1();
    redis = new MemoryRedis();
    database.sqlite.exec(`
      CREATE TABLE users (uid TEXT PRIMARY KEY, role TEXT, karma INTEGER, points INTEGER, created_at TEXT, last_active TEXT);
      CREATE TABLE ugc_submissions (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, poi_id TEXT, created_at TEXT, status TEXT, moderation_note TEXT, parent_id TEXT);
      ${UGC_COMPETING_INDEXES_SQL}
      CREATE TABLE progress_stats_outbox (id INTEGER PRIMARY KEY, uid TEXT, status TEXT, created_at INTEGER, processed_at INTEGER);
      ${readFileSync(new URL("../../../migrations/0033_query_efficiency_indexes.sql", import.meta.url), "utf8")}
    `);
  });
  afterEach(() => { database.sqlite.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

  function insertUser(uid: string, options: { karma?: number; points?: number; role?: string; lastActive?: string } = {}) {
    database.sqlite.prepare("INSERT INTO users VALUES (?, ?, ?, ?, '2026-09-05 11:00:00', ?)")
      .run(uid, options.role ?? "n", options.karma ?? 0, options.points ?? 150, options.lastActive ?? "2026-09-05 11:00:00");
  }

  it("covers every eligible user across batches before waiting for the next 12-hour cycle", async () => {
    for (let index = 0; index < 7; index += 1) insertUser(`user-${index}`);
    insertUser("robot", { role: "r" });
    insertUser("pinned", { karma: 5, points: 0 });
    expect(rules.getKarmaEvaluationIntervalSeconds()).toBe(43200);
    const first = await evaluateKarmaIfDue(database.db, redis.redis);
    expect(first).toMatchObject({ selected: 3, updated: 3, cycleComplete: false, nextRunAt: START + INTERVAL });
    vi.setSystemTime(START + 60000);
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ selected: 3, cycleComplete: false });
    vi.setSystemTime(START + 120000);
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ selected: 1, cycleComplete: true });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE karma = 2").get()?.count).toBe(7);
    expect(database.sqlite.prepare("SELECT karma FROM users WHERE uid = 'pinned'").get()?.karma).toBe(5);
    const queries = database.queries.length;
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ evaluated: false });
    expect(database.queries).toHaveLength(queries);
    vi.setSystemTime(START + INTERVAL);
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ evaluated: true, selected: 3, updated: 0 });
  });

  it("uses indexed sweeps and user-scoped image aggregation and writes only changed karma", async () => {
    insertUser("changed");
    insertUser("unchanged", { karma: 2 });
    const batch = vi.spyOn(database, "batch");
    const result = await evaluateKarmaIfDue(database.db, redis.redis);
    expect(result).toMatchObject({ selected: 2, updated: 1, cycleComplete: true });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(1);
    const sweep = database.queries.find((query) => query.sql.includes("ORDER BY uid"))!;
    const aggregation = database.queries.find((query) => query.sql.includes("image_stats"))!;
    expect(database.explain(sweep)).toContain("idx_users_karma_sweep");
    expect(database.explain(aggregation)).toContain("idx_ugc_user_kind_poi_created");
    expect(database.queries.filter((query) => query.sql.startsWith("UPDATE"))).toHaveLength(1);
  });

  it("still evaluates inactivity decay without a dirty-user marker", async () => {
    insertUser("inactive", { karma: 2, points: 150, lastActive: "2025-01-01 00:00:00" });
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ selected: 1, updated: 1 });
    expect(database.sqlite.prepare("SELECT karma FROM users WHERE uid = 'inactive'").get()?.karma).toBe(0);
  });

  it("looks up only the 90 selected users' images despite competing kind indexes and unrelated image history", async () => {
    vi.mocked(rules.getKarmaEvaluationBatchSize).mockReturnValue(90);
    for (let index = 0; index < 90; index += 1) insertUser(`selected-${String(index).padStart(3, "0")}`);
    database.sqlite.exec(`
      WITH RECURSIVE sequence(number) AS (
        SELECT 1 UNION ALL SELECT number + 1 FROM sequence WHERE number < 10000
      )
      INSERT INTO ugc_submissions (id, user_id, kind, status)
        SELECT 'outside-' || number, 'outside-user', 'image', 'active' FROM sequence;
      INSERT INTO ugc_submissions (id, user_id, kind, status)
        VALUES ('selected-image', 'selected-000', 'image', 'active');
    `);
    const score = vi.spyOn(rules, "calculateKarmaEvaluationScore");
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ selected: 90 });
    expect(score.mock.calls.map(([payload]) => payload.approvedImages).reduce((total, count) => total + count, 0)).toBe(1);
    const aggregation = database.queries.find((query) => query.sql.includes("image_stats"))!;
    const plan = database.explain(aggregation);
    expect(plan).toContain("SEARCH s USING INDEX idx_ugc_user_kind_poi_created (user_id=? AND kind=?)");
    expect(plan).not.toContain("idx_ugc_comment_threads");
    expect(plan).not.toMatch(/SCAN s USING INDEX|SCAN ugc_submissions\b/);
  });

  it("does not advance the cursor or sleep for 12 hours after a failed write", async () => {
    insertUser("first");
    const batch = vi.spyOn(database, "batch").mockRejectedValueOnce(new Error("D1 overloaded"));
    await expect(evaluateKarmaIfDue(database.db, redis.redis)).rejects.toThrow("D1 overloaded");
    expect(await redis.get(CYCLE_KEY)).toMatchObject({ cursor: "" });
    expect(await redis.get(LEASE_KEY)).toBeNull();
    batch.mockRestore();
    vi.setSystemTime(START + 60000);
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ selected: 1, updated: 1, cycleComplete: true });
  });

  it("resumes after an intermediate chunk failed without rewriting committed karma", async () => {
    vi.mocked(rules.getKarmaEvaluationBatchSize).mockReturnValue(1000);
    for (let index = 0; index < 100; index += 1) insertUser(`user-${String(index).padStart(3, "0")}`);
    const originalBatch = database.batch.bind(database);
    vi.spyOn(database, "batch").mockImplementationOnce(originalBatch)
      .mockRejectedValueOnce(new Error("second chunk failed"));
    await expect(evaluateKarmaIfDue(database.db, redis.redis)).rejects.toThrow("second chunk failed");
    expect(await redis.get(CYCLE_KEY)).toMatchObject({ cursor: "" });
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ selected: 100, updated: 10, cycleComplete: true });
    expect(database.queries.filter((query) => query.sql.startsWith("UPDATE"))).toHaveLength(100);
  });

  it("honors an existing lease and retries after its expiry", async () => {
    insertUser("first");
    await redis.set(LEASE_KEY, "another-worker", { ex: 180 });
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ evaluated: false });
    expect(await evaluateKarmaBatch(database.db, redis.redis)).toMatchObject({ evaluated: false });
    expect(database.queries).toHaveLength(0);
    vi.setSystemTime(START + 181000);
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ evaluated: true, selected: 1 });
  });

  it("cannot checkpoint or release a newer worker's lease", async () => {
    insertUser("first");
    let saves = 0;
    redis.beforeSave = () => {
      saves += 1;
      if (saves === 2) redis.records.set(LEASE_KEY, { value: "new-owner" });
    };
    await expect(evaluateKarmaIfDue(database.db, redis.redis)).rejects.toThrow("KARMA_EVALUATION_LEASE_LOST");
    expect(await redis.get(LEASE_KEY)).toBe("new-owner");
    expect(await redis.get(CYCLE_KEY)).toMatchObject({ cursor: "" });
  });

  it("allows an explicit manual run early but does not reset an in-progress cursor", async () => {
    for (let index = 0; index < 4; index += 1) insertUser(`user-${index}`);
    await evaluateKarmaIfDue(database.db, redis.redis);
    expect(await evaluateKarmaBatch(database.db, redis.redis)).toMatchObject({ selected: 1, cycleComplete: true });
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ evaluated: false });
    expect(await evaluateKarmaBatch(database.db, redis.redis)).toMatchObject({ selected: 3, updated: 0, cycleComplete: false });
  });

  it("checkpoints a partial page at the time budget and resumes without rereading completed users", async () => {
    vi.mocked(rules.getKarmaEvaluationBatchSize).mockReturnValue(1000);
    for (let index = 0; index < 100; index += 1) insertUser(`user-${String(index).padStart(3, "0")}`);
    const originalBatch = database.batch.bind(database);
    vi.spyOn(database, "batch").mockImplementationOnce(async (statements) => {
      const results = await originalBatch(statements);
      vi.setSystemTime(START + 46000);
      return results;
    });
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ selected: 90, cycleComplete: false });
    expect(await redis.get(CYCLE_KEY)).toMatchObject({ cursor: "user-089" });
    vi.setSystemTime(START + 60000);
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ selected: 10, cycleComplete: true });
  });

  it("sleeps without D1 queries after an empty sweep", async () => {
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ selected: 0, cycleComplete: true });
    expect(database.queries).toHaveLength(1);
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ evaluated: false });
    expect(database.queries).toHaveLength(1);
  });

  it("does not commit a score calculated before concurrent point or role changes", async () => {
    insertUser("first");
    const originalBatch = database.batch.bind(database);
    vi.spyOn(database, "batch").mockImplementationOnce(async (statements) => {
      database.sqlite.exec("UPDATE users SET points = 900, role = 'p' WHERE uid = 'first'");
      return originalBatch(statements);
    });
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ selected: 1, updated: 0 });
    expect(await evaluateKarmaBatch(database.db, redis.redis)).toMatchObject({ selected: 1, updated: 1 });
    expect(database.sqlite.prepare("SELECT karma FROM users WHERE uid = 'first'").get()?.karma).toBe(4);
  });
});
