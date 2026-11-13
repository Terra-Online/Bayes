import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { updateProfile } from "@/services/profile";
import { insertCommentSnapshot } from "@/test/fixtures/commentSnapshots";

import { applyMigrations, migrations } from "./migrations";
import { SqliteD1 } from "./sqliteD1";

describe("unified user migration", () => {
  let database: DatabaseSync;
  let d1: SqliteD1;
  beforeEach(() => {
    d1 = new SqliteD1();
    database = d1.sqlite;
    applyMigrations(
      database,
      migrations.filter((file) => file < "0040"),
    );
  });
  afterEach(() => database.close());

  function migrate() {
    applyMigrations(
      database,
      migrations.filter((file) => file >= "0040"),
    );
  }

  it("keeps pending users eligible to finalize their suffix and preserves confirmed users' UIDs", async () => {
    database.exec(`
      INSERT INTO auth_users (id, name, email) VALUES
        ('pending-auth', 'Pending', 'pending@example.test'),
        ('confirmed-auth', 'Confirmed', 'confirmed@example.test');
      INSERT INTO users (uid, email, password_hash, nickname, uid_number, uid_suffix, nickname_customized) VALUES
        ('pending-business', 'pending@example.test', '', 'DefaultName', 100123, 'AA', 0),
        ('confirmed-business', 'confirmed@example.test', '', 'ChosenName', 100124, 'AB', 1);
    `);
    migrate();
    expect(
      database
        .prepare("SELECT id, uid_number, uid_suffix, nickname_confirmed FROM users ORDER BY id")
        .all(),
    ).toEqual([
      { id: "confirmed-auth", uid_number: 100124, uid_suffix: "AB", nickname_confirmed: 1 },
      { id: "pending-auth", uid_number: 100123, uid_suffix: "AA", nickname_confirmed: 0 },
    ]);
    expect(
      await updateProfile(d1.db, { userId: "pending-auth", nickname: "Explorer" }),
    ).toMatchObject({ uid: "100123ER", needsProfileSetup: false });
    expect(
      await updateProfile(d1.db, { userId: "pending-auth", nickname: "Navigator" }),
    ).toMatchObject({ uid: "100123ER" });
    expect(
      await updateProfile(d1.db, { userId: "confirmed-auth", nickname: "NewName" }),
    ).toMatchObject({ uid: "100124AB" });
  });

  it("keeps the authentication ID and public UID while moving business references", () => {
    database.exec(`
      INSERT INTO auth_users (id, name, email, emailVerified) VALUES ('auth-id', 'Provider', 'owner@example.test', 1);
      INSERT INTO users (uid, email, password_hash, nickname, uid_number, uid_suffix, points, nickname_customized)
        VALUES ('business-id', 'OWNER@example.test', 'better-auth-managed', 'Owner', 123456, 'AB', 31, 1);
      INSERT INTO endfield_bindings (uid, provider, server_id, role_id, cred_enc, token_enc)
        VALUES ('business-id', 'skland', 1, 'role', 'cred', 'token');
      INSERT INTO auth_accounts (id, userId, providerId, accountId) VALUES ('account', 'auth-id', 'github', 'external');
    `);
    insertCommentSnapshot(database, {
      id: "comment",
      userId: "business-id",
      content: "Original content",
    });
    database.exec(`
      UPDATE ugc_submissions SET deleted_at='2026-09-11', deleted_by='business-id', lifecycle_version=1;
      INSERT INTO ugc_submission_audit
        (id,submission_id,action,actor_user_id,deleted_at,deleted_by,lifecycle_version,note,created_at)
        VALUES ('deletion','comment','deleted','business-id','2026-09-11','business-id',1,'Retain this fact','2026-09-11');
      INSERT INTO ugc_submission_flags (submission_id,user_id) VALUES ('comment','business-id');
      INSERT INTO ugc_submission_flag_audit
        (id,submission_id,reporter_user_id,action,actor_user_id,operation_id,created_at)
        VALUES ('flag','comment','business-id','activated','business-id','operation','2026-09-10');
      INSERT INTO ugc_snapshots_review_audit (id,snapshot_id,from_status,to_status,source,admin_user_id)
        VALUES ('review','snapshot-comment','pending_audit','approved','admin','business-id');
    `);
    migrate();
    expect(
      database
        .prepare("SELECT id, email, uid_number, uid_suffix, points, nickname_confirmed FROM users")
        .get(),
    ).toEqual({
      id: "auth-id",
      email: "owner@example.test",
      uid_number: 123456,
      uid_suffix: "AB",
      points: 31,
      nickname_confirmed: 1,
    });
    expect(database.prepare("SELECT uid FROM endfield_bindings").get()?.uid).toBe("auth-id");
    expect(database.prepare("SELECT userId FROM auth_accounts").get()?.userId).toBe("auth-id");
    expect(database.prepare("SELECT user_id FROM ugc_submissions").get()?.user_id).toBe("auth-id");
    expect(database.prepare("SELECT creator_user_id, content FROM ugc_snapshots").get()).toEqual({
      creator_user_id: "auth-id",
      content: "Original content",
    });
    expect(() => database.exec("UPDATE ugc_snapshots SET content = 'Changed content'")).toThrow(
      "snapshot content and provenance are immutable",
    );
    expect(() => database.exec("UPDATE ugc_snapshots SET creator_user_id = 'business-id'")).toThrow(
      "snapshot content and provenance are immutable",
    );
    expect(() =>
      database.exec("UPDATE ugc_snapshots SET edit_note = 'Changed provenance'"),
    ).toThrow("snapshot content and provenance are immutable");
    expect(database.prepare("SELECT deleted_by FROM ugc_submissions").get()).toEqual({
      deleted_by: "auth-id",
    });
    expect(
      database
        .prepare("SELECT actor_user_id,deleted_by,note,lifecycle_version FROM ugc_submission_audit")
        .get(),
    ).toEqual({
      actor_user_id: "auth-id",
      deleted_by: "auth-id",
      note: "Retain this fact",
      lifecycle_version: 1,
    });
    expect(
      database
        .prepare("SELECT reporter_user_id,actor_user_id,action FROM ugc_submission_flag_audit")
        .get(),
    ).toEqual({ reporter_user_id: "auth-id", actor_user_id: "auth-id", action: "activated" });
    expect(
      database.prepare("SELECT admin_user_id,to_status FROM ugc_snapshots_review_audit").get(),
    ).toEqual({ admin_user_id: "auth-id", to_status: "approved" });
    for (const table of [
      "ugc_submission_audit",
      "ugc_submission_flag_audit",
      "ugc_snapshots_review_audit",
    ]) {
      expect(() => database.exec(`UPDATE ${table} SET created_at='2027-01-01'`)).toThrow(
        "audit records are immutable",
      );
      expect(() => database.exec(`DELETE FROM ${table}`)).toThrow("audit records are immutable");
    }
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("initializes complete users for authentication identities that never had business profiles", () => {
    database.exec(`INSERT INTO auth_users (id, name, email, emailVerified)
      VALUES ('new-auth', 'Provider', 'new@example.test', 1);`);
    migrate();
    expect(
      database
        .prepare(
          "SELECT id, uid_number, uid_suffix, nickname_confirmed, role, avt, email_verified FROM users",
        )
        .get(),
    ).toEqual({
      id: "new-auth",
      uid_number: 100001,
      uid_suffix: "AA",
      nickname_confirmed: 0,
      role: "n",
      avt: 0,
      email_verified: 1,
    });
    expect(database.prepare("SELECT MAX(id) AS id FROM user_uid_sequence").get()?.id).toBe(1);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects orphan business users before changing either table", () => {
    database.exec(`INSERT INTO users (uid, email, password_hash, nickname, uid_number, uid_suffix)
      VALUES ('orphan', 'orphan@example.test', '', 'Orphan', 100001, 'AA');`);
    expect(migrate).toThrow("BUSINESS_USER_WITHOUT_AUTH_USER");
    expect(database.prepare("SELECT uid FROM users").get()?.uid).toBe("orphan");
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_users").get()?.count).toBe(0);
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_user_merge_%'").all(),
    ).toEqual([]);
  });

  it("preserves existing nicknames when initializing an auth-only user's default nickname", () => {
    database.exec(`
      INSERT INTO auth_users (id, name, email) VALUES ('owner', 'Owner', 'owner@example.test'), ('new', 'New', 'new@example.test');
      INSERT INTO users (uid, email, password_hash, nickname, uid_number, uid_suffix)
        VALUES ('owner', 'owner@example.test', '', 'U100002', 100001, 'AA');
    `);
    migrate();
    expect(database.prepare("SELECT nickname FROM users WHERE id = 'owner'").get()?.nickname).toBe(
      "U100002",
    );
    expect(
      database.prepare("SELECT uid_number, nickname FROM users WHERE id = 'new'").get(),
    ).toEqual({ uid_number: 100002, nickname: "U100002X" });
  });

  it("rejects ambiguous normalized authentication emails before changing the schema", () => {
    database.exec(`INSERT INTO auth_users (id,name,email) VALUES
      ('first','First','owner@example.test'),('second','Second','OWNER@example.test');
      INSERT INTO users(uid,email,password_hash,nickname,uid_number,uid_suffix)
        VALUES ('first','owner@example.test','','Owner',100001,'AA');`);
    expect(migrate).toThrow("AMBIGUOUS_AUTH_EMAIL");
    expect(database.prepare("SELECT uid FROM users").get()).toEqual({ uid: "first" });
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_user_merge_%'").all(),
    ).toEqual([]);
  });

  it("rejects cross-linked identities instead of moving another user's data", () => {
    database.exec(`
      INSERT INTO auth_users (id, name, email) VALUES ('first', 'First', 'first@example.test'), ('second', 'Second', 'second@example.test');
      INSERT INTO users (uid, email, password_hash, nickname, uid_number, uid_suffix)
        VALUES ('first', 'second@example.test', '', 'First', 100001, 'AA');
    `);
    expect(migrate).toThrow("CONFLICTING_USER_IDENTITIES");
    expect(database.prepare("SELECT uid, email FROM users").get()).toEqual({
      uid: "first",
      email: "second@example.test",
    });
  });
});
