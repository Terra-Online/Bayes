import { afterEach, expect, it } from "vitest";

import { collectNotifications } from "@/services/notify/collect";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { applyMigrations, migrations } from "@/test/database/migrations";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";

let database: TestDatabase;
afterEach(() => database?.close());

it("flattens legacy cards with inherited reads, preserves targets and dedupe, and does not replay old audits", async () => {
  database = createTestDatabase(migrations.filter((file) => file < "0040"));
  insertUser(database.sqlite, { uid: "owner" });
  for (const id of ["a", "b"]) {
    insertSubmission(database.sqlite, { id, userId: "owner" });
  }
  database.sqlite.exec(`INSERT INTO notifications
    (id,recipient_user_id,category,type,dedupe_key,read_at,created_at) VALUES
    ('unread','owner','system','system.submission.approved','group:unread',NULL,'2026-10-01 00:00:00'),
    ('read','owner','system','system.submission.approved','group:read','read-at','2026-10-02 00:00:00'),
    ('no-children','owner','community','community.comment.reply','old-reply',NULL,'2026-10-03 00:00:00');
    INSERT INTO notification_messages
      (id,notification_id,submission_id,marker_id,payload_json,dedupe_key,created_at) VALUES
    ('u1','unread','a','point-a','{"kind":"comment"}','system:a:snapshot-a:pending_openai:approved','2026-10-01 00:00:00'),
    ('u2','unread','b','point-b','{"kind":"comment"}','event:u2','2026-10-01 00:00:01'),
    ('r1','read','a','point-a','{"kind":"comment"}','event:r1','2026-10-02 00:00:00'),
    ('r2','read','b','point-b','{"kind":"comment"}','event:r2','2026-10-02 00:00:01');
    INSERT INTO ugc_snapshots_review_audit
      (id,snapshot_id,from_status,to_status,source,created_at)
    VALUES('old-audit','snapshot-a','pending_openai','approved','ai','2026-10-01T00:00:00.000Z');`);
  applyMigrations(
    database.sqlite,
    migrations.filter((file) => file >= "0040"),
  );
  expect(
    database.sqlite
      .prepare(`SELECT id,submission_id,marker_id,read_at FROM notifications ORDER BY id`)
      .all(),
  ).toEqual([
    { id: "legacy-message:r2", submission_id: "b", marker_id: "point-b", read_at: "read-at" },
    { id: "legacy-message:u2", submission_id: "b", marker_id: "point-b", read_at: null },
    { id: "no-children", submission_id: null, marker_id: null, read_at: null },
    { id: "read", submission_id: "a", marker_id: "point-a", read_at: "read-at" },
    { id: "unread", submission_id: "a", marker_id: "point-a", read_at: null },
  ]);
  expect(
    database.sqlite
      .prepare("SELECT system_unread,community_unread FROM notification_counters")
      .get(),
  ).toEqual({ system_unread: 2, community_unread: 1 });
  expect(
    database.sqlite
      .prepare("SELECT id,event_sequence,operation_kind FROM ugc_snapshots_review_audit")
      .get(),
  ).toEqual({ id: "old-audit", event_sequence: 1, operation_kind: "legacy" });
  expect(await collectNotifications(database.db, "owner")).toEqual([]);
  expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM notifications").get()).toEqual({
    count: 5,
  });
  expect(database.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("aborts a legacy identity collision without deleting either original card", () => {
  database = createTestDatabase(migrations.filter((file) => file < "0041"));
  insertUser(database.sqlite, { uid: "owner" });
  database.sqlite.exec(`INSERT INTO notifications
    (id,recipient_user_id,category,type,dedupe_key) VALUES
    ('group','owner','system','system.submission.approved','group'),
    ('legacy-message:second','owner','system','system.submission.approved','saved');
    INSERT INTO notification_messages(id,notification_id,dedupe_key,created_at) VALUES
    ('first','group','first','2026-10-01T00:00:00.000Z'),
    ('second','group','second','2026-10-01T00:00:01.000Z');`);
  expect(() =>
    applyMigrations(
      database.sqlite,
      migrations.filter((file) => file >= "0041"),
    ),
  ).toThrow();
  expect(database.sqlite.prepare("SELECT id FROM notifications ORDER BY id").all()).toEqual([
    { id: "group" },
    { id: "legacy-message:second" },
  ]);
  expect(
    database.sqlite.prepare("SELECT COUNT(*) AS count FROM notification_messages").get(),
  ).toEqual({ count: 2 });
});
