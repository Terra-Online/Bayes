import { Redis } from "@upstash/redis";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWithAuthRequest } from "@/lib/auth/createAuth";
import * as rules from "@/lib/karma/rules";
import { onAppError } from "@/middleware/error-handler";
import { createRoutes } from "@/routes/moderation/createRoutes";
import { createMockBindings, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser, type SessionHeaders } from "@/test/fixtures/auth";
import { insertUser as seedUser } from "@/test/fixtures/users";
import type { AppEnv } from "@/types/app";

import { evaluateKarmaIfDue, type KarmaEvaluationResult } from "./evaluation";

vi.mock("@upstash/redis", () => ({ Redis: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, exports: {} }));

interface KarmaUserFixture {
  karma?: number;
  points?: number;
  role?: string;
  lastActive?: string;
}

const LEASE_KEY = "karma:evaluation:v2:lease";
const CYCLE_KEY = "karma:evaluation:v2:cycle";
const START = Date.parse("2026-09-05T12:00:00Z");
const INTERVAL = 12 * 60 * 60 * 1000;

class MemoryRedis {
  readonly records = new Map<string, { value: unknown; expiresAt?: number }>();
  // Model the external lease protocol, not Redis Lua atomicity. Unexpected SDK
  // operations fail instead of silently succeeding.
  readonly redis = new Proxy(this, {
    get: (target, property) => {
      if (property === "then") {
        return undefined;
      }
      if (!["get", "set", "eval"].includes(String(property))) {
        throw new Error(`Unconfigured Redis operation: ${String(property)}`);
      }
      if (property === "get") {
        return target.get.bind(target);
      }
      if (property === "set") {
        return target.set.bind(target);
      }
      return target.eval.bind(target);
    },
  }) as unknown as Redis;
  beforeSave?: () => void;

  async get<Result>(key: string): Promise<Result | null> {
    const record = this.records.get(key);
    if (record?.expiresAt !== undefined && record.expiresAt <= Date.now()) {
      this.records.delete(key);
      return null;
    }
    return (record?.value as Result | undefined) ?? null;
  }

  async set(
    key: string,
    value: unknown,
    options: { nx?: boolean; ex?: number } = {},
  ): Promise<"OK" | null> {
    if (options.nx && (await this.get(key)) !== null) {
      return null;
    }
    this.records.set(key, {
      value,
      expiresAt: options.ex ? Date.now() + options.ex * 1000 : undefined,
    });
    return "OK";
  }

  async eval(script: string, keys: string[], args: unknown[]): Promise<number> {
    const operation = script.match(/redis\.call\('(SET|EXPIRE|DEL)'/g)?.[0];
    if (!script.includes("redis.call('GET', KEYS[1]) ~= ARGV[1]") || !operation) {
      throw new Error("Unconfigured Redis script");
    }
    if (script.includes("'SET'")) {
      this.beforeSave?.();
    }
    if ((await this.get(keys[0]!)) !== args[0]) {
      return 0;
    }
    if (script.includes("'SET'")) {
      this.records.set(keys[1]!, { value: JSON.parse(String(args[1])) });
    } else if (script.includes("'EXPIRE'")) {
      this.records.set(keys[0]!, {
        value: args[0],
        expiresAt: Date.now() + Number(args[1]) * 1000,
      });
    } else {
      this.records.delete(keys[0]!);
    }
    return 1;
  }
}

describe("12-hour resumable karma evaluation", () => {
  let database: TestDatabase;
  let redis: MemoryRedis;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
    database = createTestDatabase();
    redis = new MemoryRedis();
    vi.mocked(Redis).mockImplementation(function () {
      return redis.redis;
    });
  });
  afterEach(() => {
    database.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function insertKarmaUser(uid: string, options: KarmaUserFixture = {}): void {
    seedUser(database.sqlite, {
      uid,
      role: options.role ?? "n",
      karma: options.karma ?? 0,
      points: options.points ?? 150,
      created_at: "2026-09-05 11:00:00",
      last_active: options.lastActive ?? "2026-09-05 11:00:00",
    });
  }

  interface ManualRunFixture {
    app: Hono<AppEnv>;
    mocks: MockBindings;
    headers: SessionHeaders;
  }

  function createManualRun(): ManualRunFixture {
    const { headers } = insertAuthenticatedUser(database.sqlite, {
      uid: "karma-admin",
      role: "a",
      karma: 5,
      uid_number: 900001,
    });
    const mocks = createMockBindings({ DB: database.db });
    mocks.bindings.LOCK_MODERATION_ENDPOINTS = "false";
    mocks.authRateLimit.limit.mockResolvedValue({ success: true });
    const app = new Hono<AppEnv>();
    app.onError(onAppError);
    app.route("/moderation/v1", createRoutes());
    return { app, mocks, headers };
  }

  async function runManually(fixture: ManualRunFixture): Promise<KarmaEvaluationResult> {
    const response = await runWithAuthRequest(() =>
      fixture.app.request(
        "http://localhost/moderation/v1/karma/run-once",
        { method: "POST", headers: fixture.headers },
        fixture.mocks.bindings,
      ),
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as KarmaEvaluationResult & { ok: boolean };
    expect(result.ok).toBe(true);
    return result;
  }

  it("covers every eligible user across batches before waiting for the next 12-hour cycle", async () => {
    for (let index = 0; index < 2001; index += 1) {
      insertKarmaUser(`user-${String(index).padStart(4, "0")}`);
    }
    insertKarmaUser("robot", { role: "r" });
    insertKarmaUser("pinned", { karma: 5, points: 0 });
    const first = await evaluateKarmaIfDue(database.db, redis.redis);
    expect(first).toMatchObject({
      selected: 1000,
      updated: 1000,
      cycleComplete: false,
      nextRunAt: START + INTERVAL,
    });
    vi.setSystemTime(START + 60000);
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({
      selected: 1000,
      cycleComplete: false,
    });
    vi.setSystemTime(START + 120000);
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({
      selected: 1,
      cycleComplete: true,
    });
    expect(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE karma = 2").get()?.count,
    ).toBe(2001);
    expect(
      database.sqlite.prepare("SELECT karma FROM users WHERE uid = 'pinned'").get()?.karma,
    ).toBe(5);
    const queriesAfterCompletedCycle = database.queries.length;
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ evaluated: false });
    expect(database.queries).toHaveLength(queriesAfterCompletedCycle);
    vi.setSystemTime(START + INTERVAL);
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({
      evaluated: true,
      selected: 1000,
      updated: 0,
    });
  });

  it("uses indexed sweeps and user-scoped image aggregation and writes only changed karma", async () => {
    insertKarmaUser("changed");
    insertKarmaUser("unchanged", { karma: 2 });
    const result = await evaluateKarmaIfDue(database.db, redis.redis);
    expect(result).toMatchObject({ selected: 2, updated: 1, cycleComplete: true });
    // Only the changed user may be written; unchanged karma must cause no write.
    expect(database.queries.filter((query) => query.sql.startsWith("UPDATE"))).toMatchObject([
      { values: ["changed", 2, 0, 150, "2026-09-05 11:00:00", "n"], changes: 1 },
    ]);
    const sweep = database.queries.find((query) =>
      query.sql.replace(/\s+/g, " ").includes("ORDER BY uid"),
    )!;
    const aggregation = database.queries.find((query) => query.sql.includes("image_stats"))!;
    expect(database.explain(sweep)).toContain("idx_users_karma_sweep");
    expect(database.explain(aggregation)).toContain("idx_ugc_user_kind_poi_created");
  });

  it("still evaluates inactivity decay without a dirty-user marker", async () => {
    const manual = createManualRun();
    insertKarmaUser("inactive", { karma: 2, points: 150, lastActive: "2025-01-01 00:00:00" });
    expect(await runManually(manual)).toMatchObject({
      selected: 1,
      updated: 1,
    });
    expect(
      database.sqlite.prepare("SELECT karma FROM users WHERE uid = 'inactive'").get()?.karma,
    ).toBe(0);
  });

  it("looks up only the 90 selected users' images despite competing kind indexes and unrelated image history", async () => {
    for (let index = 0; index < 90; index += 1) {
      insertKarmaUser(`selected-${String(index).padStart(3, "0")}`);
    }
    seedUser(database.sqlite, { uid: "outside-user", role: "r" });
    database.sqlite.exec(`
      WITH RECURSIVE sequence(number) AS (
        SELECT 1 UNION ALL SELECT number + 1 FROM sequence WHERE number < 10000
      )
      INSERT INTO ugc_submissions (id, user_id, kind, status, poi_id, poi_hash, poi_type, snapshot_id, file_path)
        SELECT 'outside-' || number, 'outside-user', 'image', 'active', 'outside', 'hash', 'poi', 'snapshot-' || number, 'outside.webp' FROM sequence;
      INSERT INTO ugc_submissions (id, user_id, kind, status, poi_id, poi_hash, poi_type, snapshot_id, file_path)
        VALUES ('selected-image', 'selected-000', 'image', 'active', 'selected', 'hash', 'poi', 'selected-snapshot', 'selected.webp');
    `);
    // One approved image is below the scoring threshold. Keep this specialist
    // observation: final karma alone cannot prove the selected image was counted.
    const calculateScore = vi.spyOn(rules, "calculateKarmaEvaluationScore");
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ selected: 90 });
    expect(
      calculateScore.mock.calls
        .map(([payload]) => payload.approvedImages)
        .reduce((total, count) => total + count, 0),
    ).toBe(1);
    const aggregation = database.queries.find((query) => query.sql.includes("image_stats"))!;
    const plan = database.explain(aggregation);
    expect(plan).toContain(
      "SEARCH s USING INDEX idx_ugc_user_kind_poi_created (user_id=? AND kind=?)",
    );
    expect(plan).not.toContain("idx_ugc_comment_threads");
    expect(plan).not.toMatch(/SCAN s USING INDEX|SCAN ugc_submissions\b/);
  });

  it("does not advance the cursor or sleep for 12 hours after a failed write", async () => {
    insertKarmaUser("first");
    database.sqlite.exec(`CREATE TRIGGER fail_karma BEFORE UPDATE OF karma ON users
      BEGIN SELECT RAISE(ABORT, 'D1 overloaded'); END`);
    await expect(evaluateKarmaIfDue(database.db, redis.redis)).rejects.toThrow("D1 overloaded");
    expect(await redis.get(CYCLE_KEY)).toMatchObject({ cursor: "" });
    expect(await redis.get(LEASE_KEY)).toBeNull();
    database.sqlite.exec("DROP TRIGGER fail_karma");
    vi.setSystemTime(START + 60000);
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({
      selected: 1,
      updated: 1,
      cycleComplete: true,
    });
  });

  it("resumes after an intermediate chunk failed without rewriting committed karma", async () => {
    for (let index = 0; index < 100; index += 1) {
      insertKarmaUser(`user-${String(index).padStart(3, "0")}`);
    }
    database.sqlite.exec(`CREATE TRIGGER fail_second_chunk BEFORE UPDATE OF karma ON users
      WHEN OLD.uid = 'user-090'
      BEGIN SELECT RAISE(ABORT, 'second chunk failed'); END`);
    await expect(evaluateKarmaIfDue(database.db, redis.redis)).rejects.toThrow(
      "second chunk failed",
    );
    expect(await redis.get(CYCLE_KEY)).toMatchObject({ cursor: "" });
    database.sqlite.exec("DROP TRIGGER fail_second_chunk");
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({
      selected: 100,
      updated: 10,
      cycleComplete: true,
    });
    expect(database.queries.filter((query) => query.sql.startsWith("UPDATE"))).toHaveLength(100);
  });

  it("honors an existing lease and retries after its expiry", async () => {
    const manual = createManualRun();
    insertKarmaUser("first");
    await redis.set(LEASE_KEY, "another-worker", { ex: 180 });
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ evaluated: false });
    expect(database.queries).toHaveLength(0);
    expect(await runManually(manual)).toMatchObject({ evaluated: false });
    // Permit only the real session middleware's schema discovery and identity
    // reads. Any other SQL while a lease is held violates the no-work guarantee.
    const authQueries = [
      {
        sql: 'select "name", "type" from "sqlite_master" where "type" in (?, ?) and "name" not like ? and "name" not like ? and "name" != ? and "name" != ?',
        values: ["table", "view", "sqlite_%", "_cf_%", "kysely_migration", "kysely_migration_lock"],
      },
      ...["auth_users", "auth_sessions", "auth_accounts", "auth_verifications"].map((table) => ({
        sql: "SELECT * FROM pragma_table_info(?)",
        values: [table],
      })),
      {
        sql: 'select "primary".* from (select * from "auth_sessions" where "auth_sessions"."token" = ?) as "primary"',
        values: [manual.headers.authorization.slice("Bearer ".length)],
      },
      {
        sql: 'select "primary".* from (select * from "auth_users" where "auth_users"."id" = ?) as "primary"',
        values: ["karma-admin"],
      },
      { sql: "SELECT * FROM users WHERE uid = ?1 LIMIT 1", values: ["karma-admin"] },
    ];
    expect(
      database.queries.filter(
        (query) =>
          !authQueries.some(
            (auth) =>
              query.sql === auth.sql &&
              JSON.stringify(query.values) === JSON.stringify(auth.values) &&
              query.changes === 0,
          ),
      ),
    ).toHaveLength(0);
    vi.setSystemTime(START + 181000);
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({
      evaluated: true,
      selected: 1,
    });
  });

  it("stops before writing if its lease expires during selection and evaluates successfully on retry", async () => {
    insertKarmaUser("first");
    let leaseExpiryInjected = false;
    database.hooks.beforeQuery = (sql) => {
      if (sql.replace(/\s+/g, " ").includes("ORDER BY uid")) {
        database.hooks.beforeQuery = undefined;
        leaseExpiryInjected = true;
        vi.setSystemTime(START + 181_000);
      }
    };
    await expect(evaluateKarmaIfDue(database.db, redis.redis)).rejects.toThrow(
      "KARMA_EVALUATION_LEASE_LOST",
    );
    expect(leaseExpiryInjected).toBe(true);
    expect(database.sqlite.prepare("SELECT karma FROM users WHERE uid='first'").get()).toEqual({
      karma: 0,
    });
    expect(await redis.get(CYCLE_KEY)).toMatchObject({ cursor: "" });
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({
      selected: 1,
      updated: 1,
      cycleComplete: true,
    });
    expect(database.sqlite.prepare("SELECT karma FROM users WHERE uid='first'").get()).toEqual({
      karma: 2,
    });
  });

  it("honors a cycle another worker completed before this worker acquired the lease", async () => {
    insertKarmaUser("first");
    const set = redis.set.bind(redis);
    vi.spyOn(redis, "set").mockImplementation(async (key, value, options) => {
      const result = await set(key, value, options);
      if (key === LEASE_KEY && result === "OK") {
        redis.records.set(CYCLE_KEY, {
          value: { cursor: null, startedAt: START, nextRunAt: START + INTERVAL },
        });
      }
      return result;
    });
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ evaluated: false });
    expect(database.sqlite.prepare("SELECT karma FROM users WHERE uid='first'").get()).toEqual({
      karma: 0,
    });
    expect(await redis.get(LEASE_KEY)).toBeNull();
    vi.restoreAllMocks();
    vi.setSystemTime(START + INTERVAL);
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({
      selected: 1,
      updated: 1,
    });
  });

  it("cannot checkpoint or release a newer worker's lease", async () => {
    insertKarmaUser("first");
    let checkpointAttempts = 0;
    redis.beforeSave = () => {
      checkpointAttempts += 1;
      // Steal the lease after the initial cycle save, just before checkpointing.
      if (checkpointAttempts === 2) {
        redis.records.set(LEASE_KEY, { value: "new-owner" });
      }
    };
    await expect(evaluateKarmaIfDue(database.db, redis.redis)).rejects.toThrow(
      "KARMA_EVALUATION_LEASE_LOST",
    );
    expect(await redis.get(LEASE_KEY)).toBe("new-owner");
    expect(await redis.get(CYCLE_KEY)).toMatchObject({ cursor: "" });
  });

  it("allows an explicit manual run early but does not reset an in-progress cursor", async () => {
    const manual = createManualRun();
    for (let index = 0; index < 1001; index += 1) {
      insertKarmaUser(`user-${String(index).padStart(4, "0")}`);
    }
    await evaluateKarmaIfDue(database.db, redis.redis);
    expect(await runManually(manual)).toMatchObject({
      selected: 1,
      cycleComplete: true,
    });
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ evaluated: false });
    expect(await runManually(manual)).toMatchObject({
      selected: 1000,
      updated: 0,
      cycleComplete: false,
    });
  });

  it("checkpoints a partial page at the time budget and resumes without rereading completed users", async () => {
    for (let index = 0; index < 100; index += 1) {
      insertKarmaUser(`user-${String(index).padStart(3, "0")}`);
    }
    database.hooks.beforeQuery = (sql, values) => {
      if (sql.startsWith("UPDATE users SET karma") && values[0] === "user-089") {
        vi.setSystemTime(START + 46000);
      }
    };
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({
      selected: 90,
      cycleComplete: false,
    });
    expect(await redis.get(CYCLE_KEY)).toMatchObject({ cursor: "user-089" });
    vi.setSystemTime(START + 60000);
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({
      selected: 10,
      cycleComplete: true,
    });
  });

  it("sleeps without D1 queries after an empty sweep", async () => {
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({
      selected: 0,
      cycleComplete: true,
    });
    expect(database.queries).toHaveLength(1);
    expect(await evaluateKarmaIfDue(database.db, redis.redis)).toMatchObject({ evaluated: false });
    expect(database.queries).toHaveLength(1);
  });

  it("does not commit a score calculated before concurrent point or role changes", async () => {
    insertKarmaUser("first");
    const manual = createManualRun();
    database.hooks.beforeQuery = (sql) => {
      if (sql.startsWith("UPDATE users SET karma")) {
        database.hooks.beforeQuery = undefined;
        database.sqlite.exec("UPDATE users SET points = 900, role = 'p' WHERE uid = 'first'");
      }
    };
    expect(await runManually(manual)).toMatchObject({
      selected: 1,
      updated: 0,
    });
    expect(await runManually(manual)).toMatchObject({
      selected: 1,
      updated: 1,
    });
    expect(
      database.sqlite.prepare("SELECT karma FROM users WHERE uid = 'first'").get()?.karma,
    ).toBe(4);
  });
});
