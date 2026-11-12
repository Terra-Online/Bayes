import { afterEach, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { applyMigrations, migrations } from "@/test/database/migrations";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";
import { insertUser } from "@/test/fixtures/users";

let database: TestDatabase;
afterEach(() => database?.close());

it("coalesces the first deletion without inventing audit events or losing retained content", () => {
  database = createTestDatabase(migrations.filter((file) => file < "0039"));
  insertUser(database.sqlite, { uid: "author" });
  insertUser(database.sqlite, { uid: "admin", role: "a" });
  insertCommentSnapshot(database.sqlite, { id: "author-first", userId: "author" });
  insertCommentSnapshot(database.sqlite, { id: "admin-first", userId: "author" });
  database.sqlite.exec(`UPDATE ugc_submissions SET
    author_deleted_at='2026-01-01T00:00:00Z', admin_deleted_at='2026-02-01T00:00:00Z', admin_deleted_by='admin'
    WHERE id='author-first';
    UPDATE ugc_submissions SET
    author_deleted_at='2026-02-01T00:00:00Z', admin_deleted_at='2026-01-01T00:00:00Z', admin_deleted_by='admin'
    WHERE id='admin-first';`);
  applyMigrations(
    database.sqlite,
    migrations.filter((file) => file >= "0039"),
  );
  expect(
    database.sqlite
      .prepare("SELECT id,deleted_at,deleted_by FROM ugc_submissions ORDER BY id")
      .all(),
  ).toEqual([
    { id: "admin-first", deleted_at: "2026-01-01T00:00:00Z", deleted_by: "admin" },
    { id: "author-first", deleted_at: "2026-01-01T00:00:00Z", deleted_by: "author" },
  ]);
  expect(
    database.sqlite.prepare("SELECT COUNT(*) AS count FROM ugc_submission_audit").get(),
  ).toEqual({ count: 0 });
  expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM ugc_snapshots").get()).toEqual({
    count: 2,
  });
  expect(
    database.sqlite.prepare("SELECT COUNT(*) AS count FROM v_ugc_public_submissions").get(),
  ).toEqual({ count: 0 });
  expect(database.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
