import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as authFactory from "@/lib/auth/createAuth";
import { createMockBindings } from "@/test/bindings";
import { insertAuthenticatedUser, type AuthenticatedUserFixture } from "@/test/fixtures/auth";
import { createAuthCacheFixture, type AuthCacheFixture } from "@/test/fixtures/authCache";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";

import { invalidateAuthUserCache, resolveAuthIdentity, resolveAuthUser } from "./identity";

const overview = "/me/v1/overview";
const status = "/binding/v1/endfield/status";

describe("request-owned auth lookups", () => {
  let fixture: AuthCacheFixture;
  let owner: AuthenticatedUserFixture;
  beforeEach(() => {
    fixture = createAuthCacheFixture();
    owner = insertAuthenticatedUser(fixture.database.sqlite, {
      uid: crypto.randomUUID(),
      uid_number: 100001,
      email: "first@example.test",
      nickname: "First",
    });
  });
  afterEach(async () => {
    await fixture.close();
    vi.restoreAllMocks();
  });
  const sessionReads = () =>
    fixture.database.queries.filter((q) => /from "auth_sessions"/i.test(q.sql));
  const profileReads = () =>
    fixture.database.queries.filter((q) => /^SELECT \* FROM users WHERE uid =/i.test(q.sql));

  it.each([undefined, "analytics=abc; cf_clearance=xyz"])(
    "avoids auth initialization without credentials (%s)",
    async (cookie) => {
      const requestHeaders = new Headers(cookie ? { cookie } : undefined);
      // Observational spy: construction is itself the precheck contract.
      const createAuth = vi.spyOn(authFactory, "createAuth");
      await expect(
        resolveAuthIdentity(fixture.external.bindings, requestHeaders),
      ).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
      const response = await fixture.request(overview, requestHeaders);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "SESSION_REQUIRED" });
      expect(createAuth).not.toHaveBeenCalled();
      expect(fixture.database.queries).toHaveLength(0);
    },
  );

  it("does not join another request's pending identity lookup, and can retry failure", async () => {
    const gate = fixture.pauseRead("auth_sessions");
    const first = fixture.request(status, owner.headers);
    await gate.entered;
    // The identity-only helper is intentional: a completed HTTP profile would
    // mask a broken identity cache with the separate completed-user cache.
    let secondUid: string | undefined;
    const next = authFactory.runWithAuthRequest(async () => {
      const identity = await resolveAuthIdentity(
        fixture.external.bindings,
        new Headers(owner.headers),
      );
      expect(identity).toMatchObject({ uid: owner.user.uid, email: owner.user.email });
      secondUid = identity.uid;
    });
    await vi.waitFor(() => expect(secondUid).toBe(owner.user.uid));
    await next;
    expect(sessionReads()).toHaveLength(2);
    gate.fail(new Error("owner canceled"));
    expect((await first).status).toBe(500);
    await expect(
      resolveAuthIdentity(fixture.external.bindings, new Headers(owner.headers)),
    ).resolves.toMatchObject({ uid: owner.user.uid });
    expect(sessionReads()).toHaveLength(2);
    const completed = await fixture.request(status, owner.headers);
    expect(completed.status).toBe(200);
    expect(sessionReads()).toHaveLength(2);
  });

  it("does not join another request's pending profile lookup", async () => {
    importCurrentSubmissions(fixture.database);
    const gate = fixture.pauseRead("users");
    const first = fixture.request(overview, owner.headers);
    await gate.entered;
    let second: Response | undefined;
    const next = fixture.request(overview, owner.headers).then((response) => {
      second = response;
    });
    await vi.waitFor(() => expect(second?.status).toBe(200));
    await next;
    expect(await second!.json()).toMatchObject({ user: { email: owner.user.email } });
    expect(profileReads()).toHaveLength(2);
    gate.fail(new Error("owner canceled"));
    expect((await first).status).toBe(500);
    const completed = await fixture.request(overview, owner.headers);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ user: { email: owner.user.email } });
    expect(profileReads()).toHaveLength(2);
  });

  it("isolates completed values by bindings/configuration and invalidates the right environment", async () => {
    const other = createAuthCacheFixture();
    try {
      const second = insertAuthenticatedUser(other.database.sqlite, {
        uid: "second",
        uid_number: 100002,
        email: "second@example.test",
      });
      // The exact credential is intentionally shared across distinct databases.
      other.database.sqlite
        .prepare("UPDATE auth_sessions SET token = ?")
        .run(owner.headers.authorization.slice(7));
      const env = fixture.external.bindings;
      const headers = new Headers(owner.headers);
      await expect(resolveAuthIdentity(env, headers)).resolves.toMatchObject({
        uid: owner.user.uid,
      });
      await expect(resolveAuthIdentity(other.external.bindings, headers)).resolves.toMatchObject({
        uid: second.user.uid,
      });
      await expect(resolveAuthIdentity(env, headers)).resolves.toMatchObject({
        uid: owner.user.uid,
      });
      invalidateAuthUserCache(headers, env);
      fixture.database.sqlite.exec("DELETE FROM auth_sessions");
      other.database.sqlite.exec("DELETE FROM auth_sessions");
      await expect(resolveAuthIdentity(env, headers)).rejects.toMatchObject({
        code: "TOKEN_EXPIRED",
      });
      await expect(resolveAuthIdentity(other.external.bindings, headers)).resolves.toMatchObject({
        uid: "second",
      });
      other.external.bindings.BETTER_AUTH_SECRET = "rotated-secret-at-least-32-characters-long";
      await expect(resolveAuthIdentity(other.external.bindings, headers)).rejects.toMatchObject({
        code: "TOKEN_EXPIRED",
      });
    } finally {
      await other.close();
    }
  });

  it("keeps completed auth values when an unrelated binding wrapper changes", async () => {
    const env = fixture.external.bindings;
    const headers = new Headers(owner.headers);
    await resolveAuthIdentity(env, headers);
    const next = {
      ...env,
      OEM_KV: {} as KVNamespace,
      OEM_ID_MAILS: createMockBindings({ DB: env.DB }).idMails,
      UPSTASH_REDIS_REST_URL: "https://unrelated.example",
      UPSTASH_REDIS_REST_TOKEN: "unrelated-token",
    };
    fixture.database.sqlite.exec("DELETE FROM auth_sessions");
    await expect(resolveAuthIdentity(next, headers)).resolves.toMatchObject({
      uid: owner.user.uid,
      email: owner.user.email,
    });
    expect(sessionReads()).toHaveLength(1);
  });

  it("never substitutes a warm cached account for a freshly verified different user", async () => {
    importCurrentSubmissions(fixture.database);
    expect((await fixture.request(overview, owner.headers)).status).toBe(200);
    const second = insertAuthenticatedUser(fixture.database.sqlite, {
      uid: "second",
      uid_number: 100002,
      email: "second@example.test",
    });
    fixture.database.sqlite
      .prepare("UPDATE auth_sessions SET userId = ? WHERE token = ?")
      .run(second.user.uid, owner.headers.authorization.slice(7));
    const response = await fixture.request("/auth/v1/session", owner.headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { uid: "100002AA", email: second.user.email },
    });
    // Also retain the helper's verified-identity protocol: it must not reauthenticate.
    const createAuth = vi.spyOn(authFactory, "createAuth");
    const user = await resolveAuthUser(fixture.external.bindings, new Headers(owner.headers), {
      uid: owner.user.uid,
      email: owner.user.email,
    });
    expect(user.uid).toBe(owner.user.uid);
    expect(createAuth).not.toHaveBeenCalled();
  });

  it("does not repopulate a revoked cache from an older pending lookup", async () => {
    const gate = fixture.pauseRead("auth_sessions");
    const first = fixture.request(status, owner.headers);
    await gate.entered;
    const revoked = await fixture.request("/auth/v1/sign-out", owner.headers, "POST");
    expect(revoked.status).toBe(200);
    expect(fixture.database.sqlite.prepare("SELECT id FROM auth_sessions").all()).toEqual([]);
    const readsAfterSignOut = sessionReads().length;
    gate.release();
    expect((await first).status).toBe(200);
    const response = await fixture.request(status, owner.headers);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "TOKEN_EXPIRED" });
    expect(sessionReads()).toHaveLength(readsAfterSignOut + 1);
  });
});
