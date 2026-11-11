import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, migrations } from "./migrations";

describe("unified user migration", () => {
  let database: DatabaseSync;
  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(
      database,
      migrations.filter((file) => file < "0039"),
    );
  });
  afterEach(() => database.close());

  function migrate() {
    applyMigrations(
      database,
      migrations.filter((file) => file >= "0039"),
    );
  }

  it("keeps the authentication ID and public UID while moving business references", () => {
    database.exec(`
      INSERT INTO auth_users (id, name, email, emailVerified) VALUES ('auth-id', 'Provider', 'owner@example.test', 1);
      INSERT INTO users (uid, email, password_hash, nickname, uid_number, uid_suffix, points, nickname_customized)
        VALUES ('business-id', 'OWNER@example.test', 'better-auth-managed', 'Owner', 123456, 'AB', 31, 1);
      INSERT INTO endfield_bindings (uid, provider, server_id, role_id, cred_enc, token_enc)
        VALUES ('business-id', 'skland', 1, 'role', 'cred', 'token');
      INSERT INTO auth_accounts (id, userId, providerId, accountId) VALUES ('account', 'auth-id', 'github', 'external');
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
