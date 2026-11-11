import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession } from "@/test/fixtures/auth";
import { createAuthCacheFixture, type AuthCacheFixture } from "@/test/fixtures/authCache";
import { insertUser } from "@/test/fixtures/users";

import { applyUserPointsDelta, readSessionUser, getUserByPublicUid } from "./users";

describe("user profiles, activity, and points", () => {
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
    const originalProfile = await readSessionUser(database.db, identity.uid);
    database.sqlite.exec("UPDATE users SET role = 's', karma = 1 WHERE id = 'user-1'");
    const refreshedProfile = await readSessionUser(database.db, identity.uid);
    expect(originalProfile.role).toBe("n");
    expect(refreshedProfile).toMatchObject({
      role: "s",
      karma: 1,
      lastActive: originalProfile.lastActive,
    });
    expect(database.queries).toHaveLength(2);
    expect(
      database.queries.every((query) => query.sql.startsWith("SELECT") && query.changes === 0),
    ).toBe(true);
  });

  it("writes the activity timestamp only once across concurrent stale-profile requests", async () => {
    database.sqlite.exec(
      "UPDATE users SET last_active = datetime('now', '-2 hours') WHERE id = 'user-1'",
    );
    await Promise.all([
      readSessionUser(database.db, identity.uid),
      readSessionUser(database.db, identity.uid),
    ]);
    expect(database.queries.reduce((total, query) => total + query.changes, 0)).toBe(1);
    const queriesBeforeNextRequest = database.queries.length;
    await readSessionUser(database.db, identity.uid);
    expect(database.queries).toHaveLength(queriesBeforeNextRequest + 1);
    expect(database.queries.at(-1)!.sql.startsWith("SELECT")).toBe(true);
  });

  it("reads the email directly from the unified authenticated user", async () => {
    insertAuthUser(database.sqlite, { id: identity.uid, email: "NEW@example.test" });
    const session = insertSession(database.sqlite, { userId: identity.uid });
    const response = await http.request("/auth/v1/session", session.headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { email: "new@example.test" } });
    expect(database.sqlite.prepare("SELECT id AS uid, email FROM users").all()).toEqual([
      { uid: identity.uid, email: "new@example.test" },
    ]);
    expect(
      database.queries
        .filter((query) => /^UPDATE users/.test(query.sql))
        .reduce((total, query) => total + query.changes, 0),
    ).toBe(0);
  });

  it("resolves users by their public UID", async () => {
    database.sqlite.exec(
      "UPDATE users SET uid_number = 103427, uid_suffix = 'VA' WHERE id = 'user-1'",
    );

    await expect(getUserByPublicUid(database.db, "103427va")).resolves.toMatchObject({
      uid: "user-1",
      email: "user@example.test",
      uidNumber: 103427,
      uidSuffix: "VA",
    });
    await expect(getUserByPublicUid(database.db, "not-a-public-uid")).resolves.toBeNull();
  });

  it("keeps earned points for a zero reward and limits a larger penalty to the user's balance", async () => {
    database.sqlite.exec("UPDATE users SET points = 31 WHERE id = 'user-1'");
    await applyUserPointsDelta(database.db, "user-1", 0);
    expect(database.sqlite.prepare("SELECT points FROM users WHERE id = 'user-1'").get()).toEqual({
      points: 31,
    });
    await applyUserPointsDelta(database.db, "user-1", -50);
    expect(database.sqlite.prepare("SELECT points FROM users WHERE id = 'user-1'").get()).toEqual({
      points: 0,
    });
  });
});
