import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth, runWithAuthRequest } from "@/lib/auth/betterAuth";
import { onAppError } from "@/middleware/error-handler";
import { createMockBindings, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import type { AppEnv, Bindings } from "@/types/app";

import { createRoutes as createEmailAuthRoutes } from "./emailRoutes";
import { createRoutes as createPasswordResetRoutes } from "./passwordResetRoutes";
import { createRoutes as createSocialAuthRoutes } from "./socialRoutes";

// The external Redis boundary supports only the commands used by the real rate limiter.
// Keep TTL/NX and sorted-set counts real so repeated sends require elapsed cooldowns.
interface AuthRateRedis {
  zremrangebyscore(key: string, min: number, max: number): Promise<number>;
  zcard(key: string): Promise<number>;
  zadd(key: string, entry: { score: number; member: string }): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  set(key: string, value: string, options: { nx: true; ex: number }): Promise<string | null>;
  ttl(key: string): Promise<number>;
}

function createAuthRateRedis(): AuthRateRedis {
  const sets = new Map<string, Map<string, number>>();
  const expires = new Map<string, number>();
  function prune(key: string) {
    if ((expires.get(key) ?? Infinity) <= Date.now()) {
      expires.delete(key);
      sets.delete(key);
    }
  }
  return {
    zremrangebyscore: vi.fn(async (key, min, max) => {
      prune(key);
      let removed = 0;
      for (const [member, score] of sets.get(key) ?? []) {
        if (score >= min && score <= max) {
          sets.get(key)!.delete(member);
          removed += 1;
        }
      }
      return removed;
    }),
    zcard: vi.fn(async (key) => {
      prune(key);
      return sets.get(key)?.size ?? 0;
    }),
    zadd: vi.fn(async (key, entry) => {
      prune(key);
      const set = sets.get(key) ?? new Map<string, number>();
      const added = set.has(entry.member) ? 0 : 1;
      set.set(entry.member, entry.score);
      sets.set(key, set);
      return added;
    }),
    expire: vi.fn(async (key, seconds) => {
      expires.set(key, Date.now() + seconds * 1000);
      return 1;
    }),
    set: vi.fn(async (key, _value, options) => {
      prune(key);
      if (expires.has(key)) {
        return null;
      }
      expires.set(key, Date.now() + options.ex * 1000);
      return "OK";
    }),
    ttl: vi.fn(async (key) => {
      prune(key);
      return Math.ceil(((expires.get(key) ?? Date.now()) - Date.now()) / 1000);
    }),
  };
}
let redis: AuthRateRedis;
vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor() {
      return redis;
    }
  },
}));

describe("Better Auth 1.7 with the production D1 table layout", () => {
  let database: TestDatabase;
  let env: Bindings;
  let external: MockBindings;
  let auth: ReturnType<typeof createAuth>;
  let app: Hono<AppEnv<{ requestId: string }>>;
  const email = "otp@example.com";
  let testNumber = 0;
  let testIp: string;
  beforeEach(() => {
    testIp = `192.0.2.${++testNumber}`;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      throw new Error(`Unconfigured external fetch: ${String(input)}`);
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    redis = createAuthRateRedis();
    database = createTestDatabase();
    external = createMockBindings({ DB: database.db });
    external.publicRateLimit.limit.mockResolvedValue({ success: true });
    external.authRateLimit.limit.mockResolvedValue({ success: true });
    external.idMails.send.mockResolvedValue({ messageId: "test-message" });
    env = {
      ...external.bindings,
      BETTER_AUTH_URL: "https://api.opendfieldmap.org",
      EMAIL_PROVIDER_MODE: "cloudflare_only",
    };
    auth = createAuth(env);
    app = new Hono<AppEnv<{ requestId: string }>>();
    app.onError(onAppError);
    app.route("/auth/v1", createEmailAuthRoutes());
    app.route("/auth/v1", createPasswordResetRoutes());
    app.route("/auth/v1", createSocialAuthRoutes());
  });
  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function request(path: string, body?: Record<string, unknown>): Promise<Response> {
    return runWithAuthRequest(() =>
      app.request(
        `https://api.opendfieldmap.org/auth/v1${path}`,
        {
          method: body ? "POST" : "GET",
          headers: {
            "content-type": "application/json",
            origin: "https://opendfieldmap.org",
            "cf-connecting-ip": testIp,
          },
          body: body ? JSON.stringify(body) : undefined,
        },
        env,
      ),
    );
  }
  async function issueOTP() {
    // Existing direct-API scenarios could resend immediately. Public sends honor cooldown.
    vi.setSystemTime(Date.now() + 121_000);
    const response = await request("/email-otp/send-verification-otp", { email, type: "sign-in" });
    expect(response.status).toBe(200);
    const message = external.idMails.send.mock.calls.at(-1)![0];
    if (!("text" in message) || typeof message.text !== "string") {
      throw new Error("Expected text OTP mail");
    }
    const otp = /\b\d{6}\b/.exec(message.text)![0];
    expect(otp).toHaveLength(6);
    return otp;
  }
  function register(otp: string) {
    return request("/register", { email, otp, password: "New-password123" });
  }
  function count(table: string) {
    return database.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
  }

  it("allows only one concurrent registration and consumes the OTP with DELETE RETURNING", async () => {
    const otp = await issueOTP();
    const responses = await Promise.all([register(otp), register(otp)]);
    expect(
      responses.map((response) => response.status).sort(),
      JSON.stringify(vi.mocked(console.error).mock.calls),
    ).toEqual([200, 400]);
    const failed = responses.find((response) => !response.ok)!;
    expect(await failed.json()).toMatchObject({ code: "INVALID_OTP" });
    expect(count("auth_users")).toBe(1);
    expect(count("auth_sessions")).toBe(1);
    expect(count("auth_accounts")).toBe(1);
    // Adapter protocol guarantee: the consumed OTP is returned by the atomic delete.
    expect(
      database.queries
        .map((query) => query.sql)
        .some((query) => /^delete from "auth_verifications".*returning \*/i.test(query)),
    ).toBe(true);
    expect((await register(otp)).status).toBe(400);
    const login = await request("/sign-in/email", { email, password: "New-password123" });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ user: { email } });
  });

  it("rejects wrong OTPs without creating a user and preserves the attempt budget", async () => {
    const otp = await issueOTP();
    const wrong = otp === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await register(wrong)).status).toBe(400);
    }
    expect((await register(otp)).status).toBe(403);
    expect(count("auth_users")).toBe(0);
    expect(count("auth_sessions")).toBe(0);
  });

  it("maps a real adapter email collision hidden behind a 500 to a safe 409", async () => {
    const otp = await issueOTP();
    database.hooks.beforeQuery = (sql) => {
      if (/^insert into "auth_users"/i.test(sql)) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: auth_users.email: SQLITE_CONSTRAINT");
      }
    };
    const response = await register(otp);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "USER_ALREADY_EXISTS" });
    expect(count("auth_sessions")).toBe(0);
  });

  it("maps failed concurrent verification writes from the actual handler to 429", async () => {
    database.hooks.beforeQuery = (sql) => {
      if (/^insert into "auth_verifications"/i.test(sql)) {
        throw new Error(
          "D1_ERROR: UNIQUE constraint failed: auth_verifications.identifier: SQLITE_CONSTRAINT",
        );
      }
    };
    const response = await request("/email-otp/send-verification-otp", { email, type: "sign-in" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(external.idMails.send).not.toHaveBeenCalled();
  });

  // No public OTP-only login endpoint exists. Keep this real Better Auth API contract.
  it("preserves confirmed accounts and old sessions on OTP sign-in", async () => {
    const signup = await register(await issueOTP());
    const previous = (await signup.json()) as { token: string; user: { id: string } };
    const context = await auth.$context;
    await context.internalAdapter.createAccount({
      userId: previous.user.id,
      accountId: "confirmed-github",
      providerId: "github",
    });
    await auth.api.signInEmailOTP({ body: { email, otp: await issueOTP() } });
    expect(count("auth_accounts")).toBe(2);
    expect(count("auth_sessions")).toBe(2);
    expect(
      await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${previous.token}` }),
      }),
    ).not.toBeNull();
  });

  it("preserves password reset preview, reset and single-use token behavior", async () => {
    expect((await register(await issueOTP())).status).toBe(200);
    expect(
      (await request("/forget-password", { email, redirectTo: "https://opendfieldmap.org" }))
        .status,
    ).toBe(200);
    const row = database.sqlite
      .prepare("SELECT identifier FROM auth_verifications WHERE identifier LIKE 'reset-password:%'")
      .get()!;
    const token = String(row.identifier).replace("reset-password:", "");
    const preview = await request(`/reset-password-preview?token=${encodeURIComponent(token)}`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ tokenValid: true, email });
    const reset = { token, newPassword: "Reset-password123", repeatPassword: "Reset-password123" };
    expect((await request("/reset-password", reset)).status).toBe(200);
    const login = await request("/sign-in/email", { email, password: "Reset-password123" });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ user: { email } });
    expect(
      (await request(`/reset-password-preview?token=${encodeURIComponent(token)}`)).status,
    ).toBe(400);
    expect((await request("/reset-password", reset)).status).toBe(400);
  });

  it("revokes only this session when password storage fails and retains the verified user", async () => {
    const otp = await issueOTP();
    database.hooks.beforeQuery = (sql) => {
      if (/^insert into "auth_accounts"/i.test(sql)) {
        throw new Error("D1_ERROR: password write failed");
      }
    };
    const response = await register(otp);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("password write failed");
    expect(count("auth_users")).toBe(1);
    expect(
      database.sqlite.prepare("SELECT emailVerified FROM auth_users").get()!.emailVerified,
    ).toBe(1);
    expect(count("auth_sessions")).toBe(0);
    expect(
      database.queries
        .map((query) => query.sql)
        .some((sql) => /^delete from auth_users/i.test(sql)),
    ).toBe(false);
    database.hooks.beforeQuery = undefined;
    const retry = await register(await issueOTP());
    expect(retry.status).toBe(200);
    expect(count("auth_users")).toBe(1);
  });

  it("cleans an unverified GitHub account on email proof and permits re-linking", async () => {
    const context = await auth.$context;
    const user = await context.internalAdapter.createUser(
      { name: "Existing", email, emailVerified: false },
      { method: "email-and-password" },
    );
    await context.internalAdapter.createAccount({
      userId: user.id,
      accountId: "external-github-id",
      providerId: "github",
    });
    const previous = await context.internalAdapter.createSession(user.id);
    const login = await auth.api.signInEmailOTP({ body: { email, otp: await issueOTP() } });
    expect(login.user.id).toBe(user.id);
    expect(login.user.emailVerified).toBe(true);
    expect(count("auth_accounts")).toBe(0);
    expect(count("auth_sessions")).toBe(1);
    await expect(
      auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${previous.token}` }) }),
    ).resolves.toBeNull();
    const linked = await context.internalAdapter.createAccount({
      userId: user.id,
      accountId: "external-github-id",
      providerId: "github",
    });
    expect(linked.userId).toBe(user.id);
    // Public unlink accepts a provider, so only the library API can distinguish these IDs.
    const headers = new Headers({ authorization: `Bearer ${login.token}` });
    await expect(
      auth.api.unlinkAccount({ body: { accountId: linked.id }, headers }),
    ).rejects.toMatchObject({ body: { code: "FAILED_TO_UNLINK_LAST_ACCOUNT" } });
    await context.internalAdapter.createAccount({
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: "synthetic-hash",
    });
    await expect(
      auth.api.unlinkAccount({ body: { accountId: "external-github-id" }, headers }),
    ).rejects.toMatchObject({ body: { code: "ACCOUNT_NOT_FOUND" } });
    await expect(
      auth.api.unlinkAccount({ body: { accountId: linked.id }, headers }),
    ).resolves.toMatchObject({ status: true });
  });

  it.each([
    ["google", "accounts.google.com"],
    ["github", "github.com"],
    ["discord", "discord.com"],
  ] as const)("preserves %s authorization URLs and database state", async (provider, host) => {
    const response = await request("/sign-in/social", {
      provider,
      callbackURL: "https://opendfieldmap.org",
      disableRedirect: true,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    const url = new URL(body.url);
    expect(url.hostname).toBe(host);
    expect(url.searchParams.get("redirect_uri")).toBe(
      `https://api.opendfieldmap.org/auth/v1/callback/${provider}`,
    );
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(count("auth_verifications")).toBe(1);
    const profile = { sub: "google-subject", email, email_verified: true, name: "Google User" };
    const idToken = `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(profile)).toString("base64url")}.synthetic-signature`;
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const requested = String(input instanceof Request ? input.url : input);
      let data: unknown;
      if (
        [
          "https://oauth2.googleapis.com/token",
          "https://github.com/login/oauth/access_token",
          "https://discord.com/api/oauth2/token",
        ].includes(requested)
      ) {
        data = {
          access_token: "synthetic-provider-access",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: idToken,
        };
      } else if (requested === "https://api.github.com/user") {
        data = { id: 12345, email, name: "GitHub User", login: "synthetic" };
      } else if (requested === "https://api.github.com/user/emails") {
        data = [{ email, primary: true, verified: true }];
      } else if (
        ["https://discord.com/api/users/@me", "https://discord.com/api/users/%40me"].includes(
          requested,
        )
      ) {
        data = {
          id: "12345",
          email,
          username: "Discord User",
          verified: true,
          avatar: "synthetic",
        };
      } else {
        throw new Error(`Unexpected mocked OAuth request: ${requested}`);
      }
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });
    });
    const callbackURL = new URL(`https://api.opendfieldmap.org/auth/v1/callback/${provider}`);
    callbackURL.searchParams.set("state", url.searchParams.get("state")!);
    callbackURL.searchParams.set("code", "synthetic-code");
    const callback = await request(
      `${callbackURL.pathname.replace("/auth/v1", "")}${callbackURL.search}`,
    );
    expect(callback.status, JSON.stringify(vi.mocked(console.error).mock.calls)).toBe(302);
    const redirect = new URL(callback.headers.get("location")!);
    // The production callback adds its exchange code to the same frontend destination.
    expect(redirect.origin + redirect.pathname).toBe("https://opendfieldmap.org/");
    expect(redirect.searchParams.get("auth_code")).toBeTruthy();
    const cookie = callback.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Secure-oem-chips.session_token="));
    expect(cookie).toContain("Partitioned");
    expect(count("auth_accounts")).toBe(1);
    expect(count("auth_sessions")).toBe(1);
    const account = database.sqlite
      .prepare("SELECT id, accountId, providerId FROM auth_accounts")
      .get()!;
    expect(account.providerId).toBe(provider);
    expect(account.id).not.toBe(account.accountId);
    await request(`${callbackURL.pathname.replace("/auth/v1", "")}${callbackURL.search}`);
    expect(count("auth_sessions")).toBe(1);
  });
});
