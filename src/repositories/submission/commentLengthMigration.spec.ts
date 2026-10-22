import { readFileSync } from "node:fs";

import { afterEach, beforeEach, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { migrations } from "@/test/database/migrations";
import { insertNotification } from "@/test/fixtures/notifications";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";

const migration = readFileSync(
  new URL("../../../migrations/0037_comment_source_length.sql", import.meta.url),
  "utf8",
);
let database: TestDatabase;
beforeEach(() => {
  database = createTestDatabase(migrations.filter((file) => file < "0037"));
  insertUser(database.sqlite, { uid: "author" });
  insertSubmission(database.sqlite, { id: "comment", userId: "author" });
});
afterEach(() => database.close());

function migrate() {
  // D1 runs migrations in a transaction with foreign keys enabled.
  database.sqlite.exec("BEGIN");
  try {
    database.sqlite.exec(migration);
    database.sqlite.exec("COMMIT");
  } catch (error) {
    database.sqlite.exec("ROLLBACK");
    throw error;
  }
}

it("preserves submissions, reactions, notifications and review history during the rebuild", () => {
  insertSubmission(database.sqlite, { id: "image", userId: "author", kind: "image" });
  insertSubmission(database.sqlite, {
    id: "reply",
    userId: "author",
    parentId: "comment",
    depth: 1,
  });
  database.sqlite.exec(`
    UPDATE ugc_submissions SET edit_original_content = 'Before edit',
      edit_original_status = 'active', edit_original_snapshot_id = 'old-snapshot',
      moderation_queued_at = '2026-10-22T12:00:00Z' WHERE id = 'comment';
    INSERT INTO ugc_submission_upvotes (submission_id, user_id, active)
      VALUES ('image', 'author', 0);
    INSERT INTO ugc_submission_flags (submission_id, user_id, active)
      VALUES ('comment', 'author', 1);
    INSERT INTO ugc_submission_votes (submission_id, user_id, value, active)
      VALUES ('comment', 'author', -1, 1);
    INSERT INTO ugc_review_events
      (submission_id, snapshot_id, from_status, to_status, source, created_at)
      VALUES ('comment', 'snapshot-comment', 'pending_audit', 'active', 'manual_moderation', '2026-10-22');
  `);
  insertNotification(database.sqlite, { id: "notice", recipientUserId: "author" });
  database.sqlite.exec(`UPDATE notifications
    SET submission_id = 'reply', parent_submission_id = 'comment' WHERE id = 'notice'`);
  const tables = [
    "ugc_submissions",
    "ugc_submission_upvotes",
    "ugc_submission_flags",
    "ugc_submission_votes",
    "notifications",
    "notification_counters",
    "ugc_review_events",
  ];
  const rows = () =>
    tables.map((table) => database.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = rows();
  migrate();
  expect(rows()).toEqual(before);
  expect(database.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(database.sqlite.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  // Rebuilt tables must retain the append-only protections, including reaction tables.
  for (const table of tables.slice(0, 4)) {
    expect(() => database.sqlite.exec(`DELETE FROM ${table}`)).toThrow(/append-only/);
  }
});

it("allows the maximum emoji source while retaining nonempty, source-size and relational constraints", () => {
  migrate();
  const update = database.sqlite.prepare(
    "UPDATE ugc_submissions SET content = ? WHERE id = 'comment'",
  );
  update.run(":sns_001:".repeat(250));
  expect(
    database.sqlite.prepare("SELECT content FROM ugc_submissions WHERE id = 'comment'").get()
      ?.content,
  ).toBe(":sns_001:".repeat(250));
  for (const content of [null, "", "   ", ":sns_001:".repeat(250) + "a"]) {
    expect(() => update.run(content)).toThrow(/CHECK constraint failed/);
  }
  expect(() => database.sqlite.exec("UPDATE ugc_submissions SET user_id = 'missing'")).toThrow(
    /FOREIGN KEY constraint failed/,
  );
  expect(() =>
    insertSubmission(database.sqlite, {
      id: "duplicate-snapshot",
      userId: "author",
      snapshotId: "snapshot-comment",
    }),
  ).toThrow(/UNIQUE constraint failed/);
  expect(() =>
    insertSubmission(database.sqlite, {
      id: "missing-file",
      userId: "author",
      kind: "image",
      filePath: null,
    }),
  ).toThrow(/CHECK constraint failed/);
});
