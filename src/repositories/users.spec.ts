import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteD1 } from "../test/sqliteD1";
import { ensureUserProfile } from "./users";

describe("profile activity write throttling", () => {
  let database: SqliteD1;
  const identity = { uid: "user-1", email: "user@example.test" };

  beforeEach(() => {
    database = new SqliteD1();
    database.sqlite.exec(`
      CREATE TABLE users (
        uid TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, role TEXT, karma INTEGER DEFAULT 0,
        avt INTEGER, nickname TEXT UNIQUE, nickname_customized INTEGER, uid_number INTEGER UNIQUE,
        uid_suffix TEXT, email_verified TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_active TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE user_uid_sequence (id INTEGER PRIMARY KEY AUTOINCREMENT);
      INSERT INTO users (uid, email, role, karma, nickname, last_active)
        VALUES ('user-1', 'user@example.test', 'n', 2, 'Tester', datetime('now', '-5 minutes'));
    `);
  });
  afterEach(() => database.sqlite.close());

  it("uses only reads for repeated activity within an hour, without caching roles or karma", async () => {
    const first = await ensureUserProfile(database.db, identity);
    database.sqlite.exec("UPDATE users SET role = 's', karma = 1 WHERE uid = 'user-1'");
    const second = await ensureUserProfile(database.db, identity);
    expect(first.role).toBe("n");
    expect(second).toMatchObject({ role: "s", karma: 1, lastActive: first.lastActive });
    expect(database.queries).toHaveLength(2);
    expect(database.queries.every((query) => query.sql.startsWith("SELECT") && query.changes === 0)).toBe(true);
  });

  it("writes the activity timestamp only once across concurrent stale-profile requests", async () => {
    database.sqlite.exec("UPDATE users SET last_active = datetime('now', '-2 hours') WHERE uid = 'user-1'");
    await Promise.all([ensureUserProfile(database.db, identity), ensureUserProfile(database.db, identity)]);
    expect(database.queries.reduce((total, query) => total + query.changes, 0)).toBe(1);
    const count = database.queries.length;
    await ensureUserProfile(database.db, identity);
    expect(database.queries).toHaveLength(count + 1);
    expect(database.queries.at(-1)!.sql.startsWith("SELECT")).toBe(true);
  });

  it("persists an email change immediately even when activity was just written", async () => {
    expect(await ensureUserProfile(database.db, { ...identity, email: "NEW@example.test" }))
      .toMatchObject({ uid: identity.uid, email: "new@example.test" });
    expect(database.queries.reduce((total, query) => total + query.changes, 0)).toBe(1);
  });

  it("preserves first-time profile creation", async () => {
    const created = await ensureUserProfile(database.db, { uid: "new-user", email: "new@example.test", displayName: "NewTester" });
    expect(created).toMatchObject({ uid: "new-user", email: "new@example.test", nickname: "NewTester", role: "n" });
    const count = database.queries.length;
    await ensureUserProfile(database.db, { uid: "new-user", email: "new@example.test" });
    expect(database.queries).toHaveLength(count + 1);
  });
});
