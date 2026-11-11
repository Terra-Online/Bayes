import { readFileSync } from "node:fs";

import { afterEach, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { migrations } from "@/test/database/migrations";
import { insertSubmission as seedSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";

import { archiveTestImageSubmissions } from "./submission-review";
let database: TestDatabase;
afterEach(() => database?.close());
it("records bulk manual archives atomically and respects escaped prefixes", async () => {
  database = createTestDatabase();
  const db = database.db;
  insertUser(database.sqlite, { uid: "owner" });
  seedSubmission(database.sqlite, {
    id: "mine",
    userId: "owner",
    kind: "image",
    snapshotId: "v1-mine",
    status: "pending_openai",
    filePath: "test_a/a.webp",
    updatedAt: "old",
    markerId: "point1",
  });
  seedSubmission(database.sqlite, {
    id: "other",
    userId: "owner",
    kind: "image",
    snapshotId: "v1-other",
    filePath: "testXa/b.webp",
    updatedAt: "old",
    markerId: "point2",
  });
  insertUser(database.sqlite, { uid: "admin", role: "a" });

  expect(await archiveTestImageSubmissions(db, { prefix: "test_a", adminUserId: "admin" })).toEqual(
    { changedRows: 1, markerIds: ["point1"] },
  );
  expect(
    database.sqlite.prepare("SELECT deleted_by FROM ugc_submissions WHERE id='mine'").get(),
  ).toEqual({ deleted_by: "admin" });
  expect(
    database.sqlite
      .prepare("SELECT review_status FROM ugc_snapshots WHERE submission_id='mine'")
      .get(),
  ).toEqual({ review_status: "pending_openai" });
  expect(
    database.sqlite.prepare("SELECT deleted_at FROM ugc_submissions WHERE id='other'").get(),
  ).toEqual({ deleted_at: null });
  expect(database.sqlite.prepare("SELECT * FROM ugc_snapshots_review_audit").all()).toEqual([]);
});
it("removes legacy rejected notifications and lets the delete trigger repair unread counters", async () => {
  database = createTestDatabase(migrations.filter((file) => file < "0030"));
  insertUser(database.sqlite, { uid: "user-1" });
  database.sqlite.exec(`
      INSERT INTO notifications (
        id, recipient_user_id, category, type, payload_json, dedupe_key, created_at
      ) VALUES
        ('legacy-rejected', 'user-1', 'system', 'system.submission.rejected', '{}', 'legacy-rejected', '2026-08-02T10:00:00.000Z'),
        ('legacy-approved', 'user-1', 'system', 'system.submission.approved', '{"kind":"image"}', 'legacy-approved', '2026-08-02T10:00:01.000Z');
    `);

  expect(
    database.sqlite
      .prepare("SELECT system_unread FROM notification_counters WHERE user_id = 'user-1'")
      .get(),
  ).toEqual({ system_unread: 2 });

  database.sqlite.exec(
    readFileSync(
      new URL("../../migrations/0030_notification_aggregation.sql", import.meta.url),
      "utf8",
    ),
  );

  expect(database.sqlite.prepare("SELECT id FROM notifications ORDER BY id").all()).toEqual([
    { id: "legacy-approved" },
  ]);
  expect(
    database.sqlite
      .prepare("SELECT system_unread FROM notification_counters WHERE user_id = 'user-1'")
      .get(),
  ).toEqual({ system_unread: 1 });
});
