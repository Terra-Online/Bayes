import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "@/test/database/createTestDatabase";
import { migrations } from "@/test/database/migrations";
import {
  importCurrentSubmissions,
  legacySnapshotSeedSql,
  retainedUgcTables,
  snapshotImportSql,
} from "@/test/fixtures/ugcSnapshots";

import { getOwnerSnapshot, getPublicSnapshot } from "./snapshotReads";

let database: ReturnType<typeof createTestDatabase>;
beforeEach(() => {
  database = createTestDatabase(migrations.filter((file) => file < "0038"));
  database.sqlite.exec("PRAGMA foreign_keys=ON");
  database.sqlite.exec(legacySnapshotSeedSql);
});
afterEach(() => database.close());

function retainedRows() {
  return Object.fromEntries(
    retainedUgcTables.map((table) => [
      table,
      database.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );
}
function legacyState() {
  return {
    schema: database.sqlite.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all(),
    submissions: database.sqlite.prepare("SELECT * FROM ugc_submissions ORDER BY id").all(),
    retained: retainedRows(),
  };
}

describe("registered current-content migration 0038", () => {
  it("commits one retained snapshot per submission without replaying notification counters", async () => {
    const before = retainedRows();
    importCurrentSubmissions(database);
    expect(retainedRows()).toEqual(before);
    expect(database.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.sqlite.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM ugc_snapshots").get()?.n).toBe(10);
    expect(database.sqlite.prepare("SELECT * FROM ugc_snapshots_review_audit").all()).toEqual([]);
    const expected = [
      ["comment-active", "approved"],
      ["comment-flagged", "approved"],
      ["comment-remove_request", "approved"],
      ["comment-stale", "unknown"],
      ["image-active", "approved"],
      ["image-flagged", "approved"],
      ["image-remove_request", "approved"],
      ["image-stale", "unknown"],
      ["image-pending_openai", "pending_openai"],
      ["image-pending_audit", "pending_audit"],
    ];
    for (const [id, reviewStatus] of expected) {
      expect(await getOwnerSnapshot(database.db, { id, ownerUserId: "owner" })).toMatchObject({
        snapshotId: `snap-${id}`,
        revision: 1,
        reviewStatus,
        userId: "owner",
      });
    }
    expect(
      database.sqlite
        .prepare(
          "SELECT creator_user_id,created_at FROM ugc_snapshots WHERE id='snap-comment-active'",
        )
        .get(),
    ).toEqual({ creator_user_id: "owner", created_at: "2025-01-01" });
    expect(await getPublicSnapshot(database.db, "comment-active")).toMatchObject({
      content: "Current A",
      createdAt: "2025-01-01",
      snapshotCreatedAt: "2025-01-01",
    });
    // Restored triggers must still maintain the retained counter after import.
    database.sqlite.exec("UPDATE notifications SET read_at='2026-03-01' WHERE id='unread'");
    expect(
      database.sqlite
        .prepare("SELECT community_unread FROM notification_counters WHERE user_id='owner'")
        .get()?.community_unread,
    ).toBe(0);
    database.sqlite.exec("UPDATE notifications SET read_at=NULL WHERE id='unread'");
    expect(
      database.sqlite
        .prepare("SELECT community_unread FROM notification_counters WHERE user_id='owner'")
        .get()?.community_unread,
    ).toBe(1);
  });

  it.each(["pending_openai", "pending_audit"])(
    "rolls back the entire import for a %s comment",
    (status) => {
      database.sqlite
        .prepare("UPDATE ugc_submissions SET status=? WHERE id='comment-active'")
        .run(status);
      const before = legacyState();
      expect(() => importCurrentSubmissions(database)).toThrow(/CHECK constraint/);
      expect(legacyState()).toEqual(before);
      // The original runtime schema remains writable after the rollback.
      database.sqlite.exec("UPDATE ugc_submissions SET status='active' WHERE id='comment-active'");
      importCurrentSubmissions(database);
      expect(database.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    },
  );

  it("rolls back detached dependencies and counters when a late statement fails", () => {
    const before = legacyState();
    database.sqlite.exec("BEGIN");
    try {
      database.sqlite.exec(snapshotImportSql);
      database.sqlite.exec("INSERT INTO ugc_snapshots(id) VALUES ('invalid')");
      throw new Error("expected late failure");
    } catch (error) {
      database.sqlite.exec("ROLLBACK");
      expect(String(error)).toContain("NOT NULL");
    }
    expect(legacyState()).toEqual(before);
    expect(database.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("aborts unexpected legacy statuses instead of silently importing them as unknown", () => {
    database.sqlite.exec(
      "PRAGMA ignore_check_constraints=ON; UPDATE ugc_submissions SET status='unexpected' WHERE id='image-active'; PRAGMA ignore_check_constraints=OFF",
    );
    const before = legacyState();
    expect(() => importCurrentSubmissions(database)).toThrow(/CHECK constraint/);
    expect(legacyState()).toEqual(before);
  });

  it("rejects historical identity/content violations without silently repairing them", () => {
    // Model a damaged historical backup; normal old writes already reject this.
    database.sqlite.exec(
      "PRAGMA ignore_check_constraints=ON; UPDATE ugc_submissions SET content='   ' WHERE id='comment-active'; PRAGMA ignore_check_constraints=OFF",
    );
    const before = legacyState();
    expect(() => importCurrentSubmissions(database)).toThrow(/CHECK constraint/);
    expect(legacyState()).toEqual(before);
  });

  it("retains immutable versions while allowing review and queue fields to change", () => {
    importCurrentSubmissions(database);
    expect(() =>
      database.sqlite.exec(
        "UPDATE ugc_snapshots SET content='overwrite' WHERE id='snap-comment-active'",
      ),
    ).toThrow(/immutable/);
    expect(() =>
      database.sqlite.exec("DELETE FROM ugc_snapshots WHERE id='snap-comment-active'"),
    ).toThrow(/retained/);
    expect(() =>
      database.sqlite.exec("DELETE FROM ugc_submissions WHERE id='comment-active'"),
    ).toThrow(/retained/);
    database.sqlite.exec(
      "UPDATE ugc_snapshots SET review_status='pending_audit',moderation_queued_at='queued' WHERE id='snap-image-pending_openai'",
    );
  });

  it("keeps revision contiguous and leaves no orphan when an atomic append fails", async () => {
    importCurrentSubmissions(database);
    // This is a storage transaction test, not the future edit command Interface.
    const append = (id: string, content: string) =>
      database.batch([
        database.prepare(
          "UPDATE ugc_submissions SET revision=revision+1 WHERE id='comment-active'",
        ),
        database
          .prepare(`INSERT INTO ugc_snapshots
        (id,submission_id,kind,revision,content,review_status,creator_user_id)
        SELECT ?,id,kind,revision,?,'pending_openai',user_id FROM ugc_submissions WHERE id='comment-active'`)
          .bind(id, content),
      ]);
    await expect(append("failed", "   ")).rejects.toThrow(/CHECK constraint/);
    expect(
      await getOwnerSnapshot(database.db, { id: "comment-active", ownerUserId: "owner" }),
    ).toMatchObject({ revision: 1, snapshotId: "snap-comment-active" });
    expect(database.sqlite.prepare("SELECT id FROM ugc_snapshots WHERE id='failed'").all()).toEqual(
      [],
    );
    await append("second", "Second body");
    database.sqlite.exec("UPDATE ugc_snapshots SET review_status='approved' WHERE id='second'");
    await append("third", "Third body");
    expect(
      database.sqlite
        .prepare(
          "SELECT revision FROM ugc_snapshots WHERE submission_id='comment-active' ORDER BY revision",
        )
        .all(),
    ).toEqual([{ revision: 1 }, { revision: 2 }, { revision: 3 }]);
    expect(database.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
