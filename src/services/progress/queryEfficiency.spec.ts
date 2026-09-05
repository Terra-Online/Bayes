import { readFileSync } from "node:fs";
import type { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteD1 } from "../../test/sqliteD1";
import { cleanupProgressConsistencyRecords, getProgressStatsOutboxHealth, listDispatchableProgressStatsEvents } from "./repository";

describe("outbox query efficiency", () => {
  let database: SqliteD1;
  let eventInsert: StatementSync;
  const now = Date.parse("2026-09-05T12:00:00Z");

  beforeEach(() => {
    database = new SqliteD1();
    database.sqlite.exec(`
      CREATE TABLE users (uid TEXT PRIMARY KEY, role TEXT, karma INTEGER);
      CREATE TABLE progress_stats_snapshots (marker_index_hash TEXT PRIMARY KEY);
      CREATE TABLE ugc_submissions (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, poi_id TEXT, created_at TEXT);
      CREATE TABLE archive_progress_sync_mutations (uid TEXT, mutation_id TEXT, created_at INTEGER);
      ${readFileSync(new URL("../../../migrations/0025_progress_consistency.sql", import.meta.url), "utf8")}
      ${readFileSync(new URL("../../../migrations/0033_query_efficiency_indexes.sql", import.meta.url), "utf8")}
      INSERT INTO users VALUES ('user-1', 'n', 1), ('blocked-user', 'n', 1);
    `);
    eventInsert = database.sqlite.prepare(`
      INSERT INTO progress_stats_outbox
        (event_id, uid, mutation_id, marker_index_hash, payload, status, next_attempt_at, created_at, processed_at)
      VALUES (?, ?, ?, 'manifest', '{}', ?, ?, ?, ?)
    `);
    database.sqlite.exec("BEGIN");
    for (let index = 0; index < 20000; index += 1) {
      insertEvent(`processed-${index}`, "processed", now - 60_000);
    }
    database.sqlite.exec("COMMIT");
  });
  afterEach(() => database.sqlite.close());

  function insertEvent(eventId: string, status: string, createdAt: number, uid = "user-1", processedAt = now) {
    eventInsert.run(eventId, uid, eventId, status, now - 1, createdAt, status === "processed" ? processedAt : null);
  }

  it("reads only the active partial index, not retained processed history", async () => {
    insertEvent("pending", "pending", now - 10000);
    insertEvent("retry", "retry", now - 40000);
    insertEvent("blocked", "blocked", now - 90000, "blocked-user");
    expect(await getProgressStatsOutboxHealth(database.db, now)).toEqual({ pending: 2, blocked: 1, oldestAgeMs: 40000 });
    const plan = database.explain(database.queries.at(-1)!);
    expect(plan).toContain("idx_progress_stats_outbox_active_health");
    expect(plan).not.toMatch(/SCAN progress_stats_outbox\s*$/m);
  });

  it("returns zero health counts when all retained events are processed", async () => {
    expect(await getProgressStatsOutboxHealth(database.db, now)).toEqual({ pending: 0, blocked: 0, oldestAgeMs: 0 });
    expect(database.explain(database.queries.at(-1)!)).toContain("idx_progress_stats_outbox_active_health");
  });

  it("preserves per-user ordering without scanning processed events in the predecessor lookup", async () => {
    insertEvent("blocked", "blocked", now - 60000, "blocked-user");
    insertEvent("behind-blocked", "pending", now - 50000, "blocked-user");
    insertEvent("pending-first", "pending", now - 40000);
    insertEvent("pending-second", "pending", now - 30000);
    const events = await listDispatchableProgressStatsEvents(database.db, now, 20);
    expect(events.map((event) => event.eventId)).toEqual(["pending-first"]);
    expect(database.explain(database.queries.at(-1)!)).toContain("idx_progress_stats_outbox_unprocessed_user");
  });

  it("cleans only expired processed records through the cleanup index", async () => {
    const old = now - 60 * 24 * 60 * 60 * 1000;
    insertEvent("expired", "processed", old, "user-1", old);
    insertEvent("old-pending", "pending", old);
    insertEvent("old-blocked", "blocked", old, "blocked-user");
    await cleanupProgressConsistencyRecords(database.db, now);
    expect(database.sqlite.prepare("SELECT id FROM progress_stats_outbox WHERE event_id = 'expired'").get()).toBeUndefined();
    expect(database.sqlite.prepare("SELECT id FROM progress_stats_outbox WHERE event_id = 'old-pending'").get()).toBeDefined();
    expect(database.sqlite.prepare("SELECT id FROM progress_stats_outbox WHERE event_id = 'old-blocked'").get()).toBeDefined();
    const cleanup = database.queries.find((query) => query.sql.includes("DELETE FROM progress_stats_outbox"))!;
    expect(database.explain(cleanup)).toContain("idx_progress_stats_outbox_processed_cleanup");
  });
});
