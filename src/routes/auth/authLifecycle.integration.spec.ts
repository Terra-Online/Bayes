import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth } from "@/lib/auth/createAuth";
import { onAppError } from "@/middleware/error-handler";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthUser, insertSession, testAuthConfig } from "@/test/fixtures/auth";
import { insertUser } from "@/test/fixtures/users";
import type { AppEnv, Bindings } from "@/types/app";

import { createRoutes as createAccountRoutes } from "./accountRoutes";
import { createRoutes as createAuthRoutes } from "./createRoutes";
import { createRoutes as createEmailRoutes } from "./emailRoutes";
import { createRoutes as createSessionRoutes } from "./sessionRoutes";
import { createRoutes as createSocialRoutes } from "./socialRoutes";

type Credentials = { authorization?: string; cookie?: string };

describe("authenticated account and profile HTTP lifecycle", () => {
  let database: TestDatabase;
  let env: Bindings;
  let app: Hono<AppEnv<{ requestId: string }>>;
  let owner: Credentials;
  let other: Credentials;
  let testNumber = 0;
  let testIp: string;

  beforeEach(() => {
    database = createTestDatabase();
    testIp = `192.0.2.${++testNumber}`;
    env = {
      DB: database.db,
      ...testAuthConfig,
      BETTER_AUTH_URL: "https://api.opendfieldmap.org",
      // Cloudflare runtime boundaries; production rate-limit middleware still runs.
      OEM_AUTH_RATE_LIMIT: { limit: async () => ({ success: true }) },
      OEM_PUBLIC_RATE_LIMIT: { limit: async () => ({ success: true }) },
    } as unknown as Bindings;
    insertAuthUser(database.sqlite, { id: "owner" });
    insertUser(database.sqlite, {
      uid: "owner",
      uid_number: 123456,
      uid_suffix: "AB",
      nickname: "OriginalName",
      avt: 7,
      role: "a",
      karma: 2,
      points: 340,
    });
    insertAuthUser(database.sqlite, { id: "other" });
    insertUser(database.sqlite, {
      uid: "other",
      uid_number: 123457,
      uid_suffix: "CD",
      nickname: "TakenName",
      avt: 9,
    });
    owner = insertSession(database.sqlite, { userId: "owner" }).headers;
    other = insertSession(database.sqlite, { userId: "other" }).headers;

    app = new Hono<AppEnv<{ requestId: string }>>();
    app.onError(onAppError);
    app.route("/auth/v1", createEmailRoutes());
    app.route("/auth/v1", createSocialRoutes());
    app.route("/auth/v1", createSessionRoutes());
    app.route("/auth/v1", createAccountRoutes());
    app.route("/auth/v1", createAuthRoutes());
  });

  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
  });

  function request(path: string, init: RequestInit = {}, credentials: Credentials = owner) {
    const headers = new Headers(credentials);
    headers.set("cf-connecting-ip", testIp);
    headers.set("origin", "https://opendfieldmap.org");
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    return app.request(`https://api.opendfieldmap.org/auth/v1${path}`, { ...init, headers }, env);
  }

  function jsonRequest(
    method: string,
    path: string,
    body: unknown,
    credentials: Credentials = owner,
  ) {
    return request(
      path,
      {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      credentials,
    );
  }

  function storedProfile(uid = "owner") {
    return database.sqlite
      .prepare(
        `SELECT uid, uid_number, uid_suffix, nickname, nickname_customized, avt,
                email, role, karma, points, created_at FROM users WHERE uid = ?`,
      )
      .get(uid);
  }

  function storedAccounts() {
    return database.sqlite.prepare("SELECT * FROM auth_accounts ORDER BY id").all();
  }

  function addAccount(
    id: string,
    provider: string,
    userId = "owner",
    linkedAt = "2026-09-02T00:00:00.000Z",
  ) {
    database.sqlite
      .prepare(
        `INSERT INTO auth_accounts
         (id, accountId, providerId, userId, createdAt, accessToken, refreshToken, password)
         VALUES (?, ?, ?, ?, ?, 'private-access-token', 'private-refresh-token', 'private-password')`,
      )
      .run(id, `external-${id}`, provider, userId, linkedAt);
  }

  it("updates a customized profile immediately while preserving its public UID and business history", async () => {
    const before = await request("/session");
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({
      user: { uid: "123456AB", nickname: "OriginalName", needsProfileSetup: false },
    });

    const response = await jsonRequest("PATCH", "/profile", {
      nickname: "  Renamed_Explorer  ",
      avatar: 12,
    });
    expect(response.status).toBe(200);
    const expected = {
      user: {
        uid: "123456AB",
        nickname: "Renamed_Explorer",
        avatar: 12,
        needsProfileSetup: false,
        email: "owner@example.test",
        role: "a",
        karma: 2,
        registeredAt: "2026-09-01T00:00:00.000Z",
      },
    };
    expect(await response.json()).toEqual(expected);
    const refreshed = await request("/session");
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toEqual(expected);
    expect(storedProfile()).toMatchObject({
      uid: "owner",
      uid_number: 123456,
      uid_suffix: "AB",
      nickname: "Renamed_Explorer",
      nickname_customized: 1,
      avt: 12,
      points: 340,
      role: "a",
      karma: 2,
      created_at: "2026-09-01T00:00:00.000Z",
    });
    expect(storedProfile("other")).toMatchObject({ nickname: "TakenName", avt: 9 });
  });

  it("completes historical nickname onboarding once and keeps the chosen public UID on later renames", async () => {
    // Current compatibility: an uncustomized profile chooses its suffix on its
    // first nickname update. Later edits preserve that public identity.
    database.sqlite.exec("UPDATE users SET nickname_customized = 0 WHERE uid = 'owner'");
    expect(await (await request("/session")).json()).toMatchObject({
      user: { uid: "123456AB", needsProfileSetup: true },
    });

    const onboarded = await jsonRequest("PATCH", "/profile", { nickname: "Explorer" });
    expect(onboarded.status).toBe(200);
    const profile = (await onboarded.json()) as { user: { uid: string } };
    expect(profile).toMatchObject({
      user: {
        uid: expect.stringMatching(/^123456[A-Z]{2}$/),
        nickname: "Explorer",
        avatar: 7,
        needsProfileSetup: false,
      },
    });
    const renamed = await jsonRequest("PATCH", "/profile", { nickname: "Pathfinder" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      user: { uid: profile.user.uid, nickname: "Pathfinder", avatar: 7, needsProfileSetup: false },
    });
    expect(await (await request("/session")).json()).toMatchObject({
      user: { uid: profile.user.uid, nickname: "Pathfinder", needsProfileSetup: false },
    });
    expect(storedProfile()).toMatchObject({
      uid: "owner",
      uid_number: 123456,
      nickname_customized: 1,
      avt: 7,
      points: 340,
    });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()!.count).toBe(2);
  });

  it.each(["json", "urlencoded", "multipart"])(
    "accepts the legacy avatar field from a %s profile client",
    async (encoding) => {
      let body: BodyInit;
      const headers = new Headers();
      if (encoding === "json") {
        headers.set("content-type", "application/json");
        body = JSON.stringify({ nickname: "FormExplorer", avt: 21 });
      } else if (encoding === "urlencoded") {
        body = new URLSearchParams({ nickname: "FormExplorer", avt: "21" });
      } else {
        const form = new FormData();
        form.set("nickname", "FormExplorer");
        form.set("avt", "21");
        body = form;
      }

      const response = await request("/profile", { method: "PATCH", headers, body });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        user: { uid: "123456AB", nickname: "FormExplorer", avatar: 21 },
      });
      expect(await (await request("/session")).json()).toMatchObject({
        user: { uid: "123456AB", nickname: "FormExplorer", avatar: 21 },
      });
      expect(storedProfile()).toMatchObject({ nickname: "FormExplorer", avt: 21 });
    },
  );

  it("rejects a taken nickname without applying the accompanying avatar change to either profile", async () => {
    const original = storedProfile();
    const otherOriginalProfile = storedProfile("other");
    const response = await jsonRequest("PATCH", "/profile", {
      nickname: "TakenName",
      avatar: 33,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "NICKNAME_TAKEN" });
    expect(storedProfile()).toEqual(original);
    expect(storedProfile("other")).toEqual(otherOriginalProfile);
    expect(await (await request("/session")).json()).toMatchObject({
      user: { uid: "123456AB", nickname: "OriginalName", avatar: 7 },
    });
    const retry = await jsonRequest("PATCH", "/profile", { nickname: "AvailableName", avatar: 33 });
    expect(retry.status).toBe(200);
    expect(storedProfile()).toMatchObject({ nickname: "AvailableName", avt: 33 });
  });

  it.each([
    { nickname: "x", avatar: 12 },
    { nickname: "Name With Spaces", avatar: 12 },
    { nickname: "ValidName", avatar: 100 },
  ])("keeps the saved profile when an edit is invalid: %j", async (payload) => {
    const original = storedProfile();
    const response = await jsonRequest("PATCH", "/profile", payload);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(storedProfile()).toEqual(original);
    expect(await (await request("/session")).json()).toMatchObject({
      user: { uid: "123456AB", nickname: "OriginalName", avatar: 7 },
    });
  });

  it("lists only the signed-in user's login methods with public labels and no account secrets", async () => {
    addAccount("owner-discord", "discord", "owner", "2026-09-04T00:00:00.000Z");
    addAccount("owner-github", "github", "owner", "2026-09-03T00:00:00.000Z");
    addAccount("owner-google", "google");
    addAccount("owner-password", "credential", "owner", "2026-09-01T00:00:00.000Z");
    addAccount("other-github", "github", "other");

    const response = await request("/list-accounts");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      accounts: [
        {
          provider: "email",
          linkedAt: "2026-09-01T00:00:00.000Z",
          verified: true,
          unlinkable: true,
        },
        { provider: "google", linkedAt: "2026-09-02T00:00:00.000Z", unlinkable: true },
        { provider: "github", linkedAt: "2026-09-03T00:00:00.000Z", unlinkable: true },
        { provider: "discord", linkedAt: "2026-09-04T00:00:00.000Z", unlinkable: true },
      ],
    });
    const otherResponse = await request("/list-accounts", {}, other);
    expect(otherResponse.status).toBe(200);
    expect(await otherResponse.json()).toEqual({
      accounts: [{ provider: "github", linkedAt: "2026-09-02T00:00:00.000Z", unlinkable: false }],
    });
  });

  it("preserves the profile after malformed, unsupported and incomplete form edits, then accepts a modern form avatar", async () => {
    const original = storedProfile();
    for (const [contentType, body, status] of [
      ["application/json", "{", 422],
      ["application/json", "null", 422],
      ["application/json", "[]", 422],
      ["text/plain", "nickname=Changed", 415],
      ["application/x-www-form-urlencoded", "avatar=12", 422],
    ] as const) {
      const response = await request("/profile", {
        method: "PATCH",
        headers: { "content-type": contentType },
        body,
      });
      expect(response.status).toBe(status);
      expect(storedProfile()).toEqual(original);
    }
    const response = await request("/profile", {
      method: "PATCH",
      body: new URLSearchParams({ nickname: "ModernForm", avatar: "17" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { uid: "123456AB", nickname: "ModernForm", avatar: 17 },
    });
  });

  it("keeps login methods after invalid link and unlink requests and a rejected rate limit", async () => {
    addAccount("github", "github");
    addAccount("discord", "discord");
    const originalAccounts = storedAccounts();
    for (const path of ["/link-social", "/unlink-account"]) {
      const response = await jsonRequest("POST", path, { provider: "unknown" });
      expect(response.status).toBe(422);
      expect(storedAccounts()).toEqual(originalAccounts);
    }
    const limit = vi
      .fn<RateLimit["limit"]>()
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValue({ success: true });
    env.OEM_AUTH_RATE_LIMIT = { limit };
    const rejected = await jsonRequest("POST", "/unlink-account", { provider: "github" });
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(storedAccounts()).toEqual(originalAccounts);
    expect((await jsonRequest("POST", "/unlink-account", { provider: "github" })).status).toBe(200);
    expect(database.sqlite.prepare("SELECT id FROM auth_accounts").all()).toEqual([
      { id: "discord" },
    ]);
  });

  it.each(["github", "email"])(
    "unlinks only the owner's %s method while retaining another login method and the current session",
    async (provider) => {
      const storedProvider = provider === "email" ? "credential" : provider;
      addAccount("owner-removed", storedProvider);
      addAccount("owner-retained", provider === "github" ? "google" : "github");
      addAccount("other-retained", storedProvider, "other");
      const originalProfile = storedProfile();

      const response = await jsonRequest("POST", "/unlink-account", { provider });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: true });
      expect(
        database.sqlite.prepare("SELECT id, userId FROM auth_accounts ORDER BY id").all(),
      ).toEqual([
        { id: "other-retained", userId: "other" },
        { id: "owner-retained", userId: "owner" },
      ]);
      expect(storedProfile()).toEqual(originalProfile);
      const list = await request("/list-accounts");
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({
        accounts: [
          {
            provider: provider === "github" ? "google" : "github",
            linkedAt: "2026-09-02T00:00:00.000Z",
            unlinkable: false,
          },
        ],
      });
      expect((await request("/session")).status).toBe(200);
      expect((await request("/list-accounts", {}, other)).status).toBe(200);
    },
  );

  it("refuses to remove the last login method", async () => {
    addAccount("last-method", "credential");
    const response = await jsonRequest("POST", "/unlink-account", { provider: "email" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "FAILED_TO_UNLINK_LAST_ACCOUNT" });
    expect(database.sqlite.prepare("SELECT id, userId FROM auth_accounts").all()).toEqual([
      { id: "last-method", userId: "owner" },
    ]);
    const list = await request("/list-accounts");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      accounts: [
        {
          provider: "email",
          linkedAt: "2026-09-02T00:00:00.000Z",
          unlinkable: false,
          verified: true,
        },
      ],
    });
    expect((await request("/session")).status).toBe(200);
  });

  it("cannot unlink a provider that belongs only to another user", async () => {
    addAccount("owner-email", "credential");
    addAccount("owner-google", "google");
    addAccount("other-github", "github", "other");
    const originalAccounts = storedAccounts();

    const response = await jsonRequest("POST", "/unlink-account", { provider: "github" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "ACCOUNT_NOT_LINKED" });
    expect(storedAccounts()).toEqual(originalAccounts);
    expect(await (await request("/list-accounts", {}, other)).json()).toEqual({
      accounts: [{ provider: "github", linkedAt: "2026-09-02T00:00:00.000Z", unlinkable: false }],
    });
  });

  it("preserves historical duplicate provider bindings when unlinking would be ambiguous", async () => {
    addAccount("first-github", "github");
    addAccount("second-github", "github");
    addAccount("password", "credential");
    const originalAccounts = storedAccounts();

    const response = await jsonRequest("POST", "/unlink-account", { provider: "github" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PROVIDER_CONFLICT" });
    expect(storedAccounts()).toEqual(originalAccounts);
    expect((await request("/session")).status).toBe(200);
  });

  it("links a verified GitHub identity to the signed-in user without replacing the public profile", async () => {
    addAccount("owner-password", "credential");
    const originalProfile = storedProfile();
    const response = await jsonRequest("POST", "/link-social", {
      provider: "github",
      callbackURL: "https://opendfieldmap.org/settings",
    });
    expect(response.status).toBe(200);
    const authorization = new URL(((await response.json()) as { url: string }).url);
    expect(authorization.hostname).toBe("github.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://api.opendfieldmap.org/auth/v1/callback/github",
    );
    const state = authorization.searchParams.get("state");
    expect(state).toBeTruthy();

    // Only the remote provider boundary is substituted. The callback, database
    // state, auth linking, and route response all use production application code.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      let data: unknown;
      if (url === "https://github.com/login/oauth/access_token") {
        data = { access_token: "github-provider-token", token_type: "Bearer" };
      } else if (url === "https://api.github.com/user") {
        data = {
          id: 12345,
          email: "owner@example.test",
          name: "GitHub Name",
          login: "github-owner",
        };
      } else if (url === "https://api.github.com/user/emails") {
        data = [{ email: "owner@example.test", primary: true, verified: true }];
      } else {
        throw new Error(`Unexpected OAuth request: ${url}`);
      }
      return Response.json(data);
    });
    const callback = await request(
      `/callback/github?state=${encodeURIComponent(state!)}&code=github-code`,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("https://opendfieldmap.org/settings");
    expect(storedProfile()).toEqual(originalProfile);
    expect(
      database.sqlite
        .prepare("SELECT userId, accountId FROM auth_accounts WHERE providerId = 'github'")
        .all(),
    ).toEqual([{ userId: "owner", accountId: "12345" }]);
    const accounts = await request("/list-accounts");
    expect(accounts.status).toBe(200);
    expect(await accounts.json()).toEqual({
      accounts: [
        {
          provider: "email",
          linkedAt: "2026-09-02T00:00:00.000Z",
          verified: true,
          unlinkable: true,
        },
        { provider: "github", linkedAt: expect.any(String), unlinkable: true },
      ],
    });
    expect(await (await request("/session")).json()).toMatchObject({
      user: { uid: "123456AB", nickname: "OriginalName" },
    });
    expect(await (await request("/list-accounts", {}, other)).json()).toEqual({ accounts: [] });
  });

  it.each(["anonymous", "expired"])(
    "protects profiles and login methods from an %s session",
    async (session) => {
      addAccount("owner-email", "credential");
      addAccount("owner-github", "github");
      if (session === "expired") {
        database.sqlite.exec(
          "UPDATE auth_sessions SET expiresAt = '2020-01-01T00:00:00.000Z' WHERE userId = 'owner'",
        );
      }
      const credentials = session === "anonymous" ? {} : owner;
      const originalProfile = storedProfile();
      const originalAccounts = storedAccounts();
      const responses = [
        await request("/list-accounts", {}, credentials),
        await jsonRequest("PATCH", "/profile", { nickname: "StolenName", avatar: 55 }, credentials),
        await jsonRequest("POST", "/link-social", { provider: "google" }, credentials),
        await jsonRequest("POST", "/unlink-account", { provider: "github" }, credentials),
      ];
      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toMatchObject({
          code: session === "anonymous" ? "SESSION_REQUIRED" : "TOKEN_EXPIRED",
        });
      }
      expect(storedProfile()).toEqual(originalProfile);
      expect(storedAccounts()).toEqual(originalAccounts);
      expect(
        database.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_verifications").get()!.count,
      ).toBe(0);
    },
  );

  it.each(["bearer", "browser", "legacy browser"])(
    "signs out a %s login immediately without revoking other sessions or deleting the profile",
    async (transport) => {
      const existing = await createAuth(env).api.signUpEmail({
        body: {
          email: "browser@example.test",
          password: "Login-password123",
          name: "BrowserOwner",
        },
      });
      insertUser(database.sqlite, {
        uid: existing.user.id,
        email: "browser@example.test",
        nickname: "BrowserOwner",
        uid_number: 123458,
        uid_suffix: "EF",
        points: 90,
      });
      const login = await jsonRequest(
        "POST",
        "/sign-in/email",
        { email: "  BROWSER@EXAMPLE.TEST  ", password: "Login-password123" },
        {},
      );
      expect(login.status).toBe(200);
      const signedIn = (await login.json()) as { token: string; user: { id: string } };
      expect(signedIn.user.id).toBe(existing.user.id);
      const cookie = login.headers
        .getSetCookie()
        .find((value) => value.startsWith("__Secure-oem-chips.session_token="))!;
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Partitioned");
      const browserCookie = cookie.split(";")[0]!;
      const credentials: Credentials =
        transport === "bearer"
          ? { authorization: `Bearer ${signedIn.token}` }
          : {
              cookie:
                transport === "legacy browser"
                  ? browserCookie.replace("__Secure-oem-chips.", "__Secure-better-auth.")
                  : browserCookie,
            };
      expect(await (await request("/session", {}, credentials)).json()).toMatchObject({
        user: { uid: "123458EF", nickname: "BrowserOwner" },
      });
      // Warm the protected-route identity cache before signing out.
      expect((await request("/list-accounts", {}, credentials)).status).toBe(200);
      const originalProfile = storedProfile(existing.user.id);
      const originalAccounts = database.sqlite.prepare("SELECT * FROM auth_accounts").all();

      const response = await request("/sign-out", { method: "POST" }, credentials);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const expirations = response.headers.getSetCookie();
      for (const name of [
        "__Secure-oem-chips.session_token",
        "__Secure-better-auth.session_token",
      ]) {
        expect(expirations.find((cookie) => cookie.startsWith(`${name}=;`))).toContain("Max-Age=0");
      }
      expect(
        database.sqlite
          .prepare("SELECT token FROM auth_sessions WHERE token = ?")
          .get(signedIn.token),
      ).toBeUndefined();

      // A protected request must fail immediately, even without a fresh /session read.
      const denied = await jsonRequest(
        "PATCH",
        "/profile",
        { nickname: "AfterSignOut", avatar: 55 },
        credentials,
      );
      expect(denied.status).toBe(401);
      expect(await denied.json()).toMatchObject({
        code: transport === "bearer" ? "TOKEN_EXPIRED" : "SESSION_REQUIRED",
      });
      expect((await request("/session", {}, credentials)).status).toBe(401);
      expect(storedProfile(existing.user.id)).toEqual(originalProfile);
      expect(database.sqlite.prepare("SELECT * FROM auth_accounts").all()).toEqual(
        originalAccounts,
      );
      expect(
        (await request("/session", {}, { authorization: `Bearer ${existing.token}` })).status,
      ).toBe(200);
      expect((await request("/session")).status).toBe(200);
      expect((await request("/session", {}, other)).status).toBe(200);
    },
  );
});
