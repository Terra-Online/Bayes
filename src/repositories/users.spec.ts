import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession } from "@/test/fixtures/auth";
import { createAuthCacheFixture, type AuthCacheFixture } from "@/test/fixtures/authCache";
import { insertUser } from "@/test/fixtures/users";

import { ensureUserProfile, getUserByPublicUid } from "./users";

describe("profile activity write throttling", () => {
  let database: TestDatabase;
  let http: AuthCacheFixture;
  const identity = { uid: "user-1", email: "user@example.test" };

  beforeEach(() => {
    http = createAuthCacheFixture();
    database = http.database;
    insertUser(database.sqlite, { ...identity, karma: 2, nickname: "Tester" });
    database.sqlite.exec("UPDATE users SET last_active = datetime('now', '-5 minutes')");
  });
  afterEach(async () => http.close());

  it("uses only reads for repeated activity within an hour, without caching roles or karma", async () => {
    const first = await ensureUserProfile(database.db, identity);
    database.sqlite.exec("UPDATE users SET role = 's', karma = 1 WHERE uid = 'user-1'");
    const second = await ensureUserProfile(database.db, identity);
    expect(first.role).toBe("n");
    expect(second).toMatchObject({ role: "s", karma: 1, lastActive: first.lastActive });
    expect(database.queries).toHaveLength(2);
    expect(
      database.queries.every((query) => query.sql.startsWith("SELECT") && query.changes === 0),
    ).toBe(true);
  });

  it("writes the activity timestamp only once across concurrent stale-profile requests", async () => {
    database.sqlite.exec(
      "UPDATE users SET last_active = datetime('now', '-2 hours') WHERE uid = 'user-1'",
    );
    await Promise.all([
      ensureUserProfile(database.db, identity),
      ensureUserProfile(database.db, identity),
    ]);
    expect(database.queries.reduce((total, query) => total + query.changes, 0)).toBe(1);
    const count = database.queries.length;
    await ensureUserProfile(database.db, identity);
    expect(database.queries).toHaveLength(count + 1);
    expect(database.queries.at(-1)!.sql.startsWith("SELECT")).toBe(true);
  });

  it("persists an email change immediately even when activity was just written", async () => {
    insertAuthUser(database.sqlite, { id: identity.uid, email: "NEW@example.test" });
    const session = insertSession(database.sqlite, { userId: identity.uid });
    const response = await http.request("/auth/v1/session", session.headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { email: "new@example.test" } });
    expect(database.sqlite.prepare("SELECT uid, email FROM users").all()).toEqual([
      { uid: identity.uid, email: "new@example.test" },
    ]);
    expect(
      database.queries
        .filter((query) => /^UPDATE users/.test(query.sql))
        .reduce((total, query) => total + query.changes, 0),
    ).toBe(1);
  });

  it("preserves first-time profile creation", async () => {
    // Historical bootstrap: auth identity exists before the business profile.
    insertAuthUser(database.sqlite, {
      id: "new-user",
      email: "new@example.test",
      name: "NewTester",
    });
    const session = insertSession(database.sqlite, { userId: "new-user" });
    const response = await http.request("/auth/v1/session", session.headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { email: "new@example.test", nickname: "NewTester", role: "n" },
    });
    expect(
      database.sqlite
        .prepare("SELECT uid, email, nickname, role FROM users WHERE uid = ?")
        .get("new-user"),
    ).toEqual({
      uid: "new-user",
      email: "new@example.test",
      nickname: "NewTester",
      role: "n",
    });
    const count = database.queries.length;
    // Fresh credentials avoid the middleware's ten-second completed-user cache.
    const next = insertSession(database.sqlite, { userId: "new-user" });
    expect((await http.request("/auth/v1/session", next.headers)).status).toBe(200);
    const profileQueries = database.queries
      .slice(count)
      .filter((query) => /\busers\b/.test(query.sql));
    expect(profileQueries).toHaveLength(1);
    expect(profileQueries[0]!.sql.startsWith("SELECT")).toBe(true);
  });

  it("resolves users by their public UID", async () => {
    database.sqlite.exec(
      "UPDATE users SET uid_number = 103427, uid_suffix = 'VA' WHERE uid = 'user-1'",
    );

    await expect(getUserByPublicUid(database.db, "103427va")).resolves.toMatchObject({
      uid: "user-1",
      email: "user@example.test",
      uidNumber: 103427,
      uidSuffix: "VA",
    });
    await expect(getUserByPublicUid(database.db, "not-a-public-uid")).resolves.toBeNull();
  });
});
