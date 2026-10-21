import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth } from "@/lib/auth/createAuth";
import { sendEmail } from "@/lib/email/sender";
import { onAppError } from "@/middleware/error-handler";
import { createAuthDatabase } from "@/test/authDatabase";
import type { AppEnv, Bindings } from "@/types/app";

import { registerEmailAuthRoutes } from "./emailRoutes";
import { forwardToAuthJsonPath, forwardToAuthRawRequest } from "./forwarding";
import { registerPasswordResetRoutes } from "./passwordResetRoutes";

vi.mock("@/lib/email/sender", () => ({ sendEmail: vi.fn() }));
vi.mock("@/middleware/rate-limit", () => ({
  rateLimit: () => async (_context: unknown, next: () => Promise<void>) => next(),
}));

describe("Better Auth 1.7 with the production D1 table layout", () => {
  let database: ReturnType<typeof createAuthDatabase>;
  let env: Bindings;
  let auth: ReturnType<typeof createAuth>;
  let app: Hono<AppEnv>;
  const email = "otp@example.com";
  let testNumber = 0;
  let testIp: string;
  beforeEach(() => {
    testIp = `192.0.2.${++testNumber}`;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(sendEmail).mockClear();
    database = createAuthDatabase();
    env = {
      DB: database.db,
      BETTER_AUTH_URL: "https://api.opendfieldmap.org",
      BETTER_AUTH_SECRET: "test-only-upgrade-secret-at-least-32-characters",
      GOOGLE_CLIENT_ID: "test-google",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GITHUB_CLIENT_ID: "test-github",
      GITHUB_CLIENT_SECRET: "test-secret",
      DISCORD_CLIENT_ID: "test-discord",
      DISCORD_CLIENT_SECRET: "test-secret",
    } as Bindings;
    auth = createAuth(env);
    app = new Hono<AppEnv>();
    app.onError(onAppError);
    registerEmailAuthRoutes(app, { forwardToAuthJsonPath, forwardToAuthRawRequest });
    registerPasswordResetRoutes(app, { forwardToAuthJsonPath });
  });
  afterEach(() => {
    database.sqlite.close();
    vi.restoreAllMocks();
  });

  async function issueOTP() {
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    const content = vi.mocked(sendEmail).mock.calls.at(-1)![0].text!;
    const otp = /\b\d{6}\b/.exec(content)![0];
    expect(otp).toHaveLength(6);
    return otp;
  }
  function register(otp: string) {
    return app.request(
      "https://api.opendfieldmap.org/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://opendfieldmap.org",
          "cf-connecting-ip": testIp,
        },
        body: JSON.stringify({ email, otp, password: "New-password123" }),
      },
      env,
    );
  }
  function count(table: string) {
    return database.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
  }

  it("allows only one concurrent registration and consumes the OTP with DELETE RETURNING", async () => {
    const otp = await issueOTP();
    const responses = await Promise.all([register(otp), register(otp)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const failed = responses.find((response) => !response.ok)!;
    expect(await failed.json()).toMatchObject({ code: "INVALID_OTP" });
    expect(count("auth_users")).toBe(1);
    expect(count("auth_sessions")).toBe(1);
    expect(count("auth_accounts")).toBe(1);
    expect(
      database.queries.some((query) =>
        /^delete from "auth_verifications".*returning \*/i.test(query),
      ),
    ).toBe(true);
    expect((await register(otp)).status).toBe(400);
    const login = await auth.api.signInEmail({ body: { email, password: "New-password123" } });
    expect(login.user.email).toBe(email);
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
    const response = await app.request(
      "https://api.opendfieldmap.org/email-otp/send-verification-otp",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://opendfieldmap.org" },
        body: JSON.stringify({ email, type: "sign-in" }),
      },
      env,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

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
    await auth.api.requestPasswordReset({
      body: { email, redirectTo: "https://opendfieldmap.org" },
    });
    const row = database.sqlite
      .prepare("SELECT identifier FROM auth_verifications WHERE identifier LIKE 'reset-password:%'")
      .get()!;
    const token = String(row.identifier).replace("reset-password:", "");
    const preview = await app.request(
      `/reset-password-preview?token=${encodeURIComponent(token)}`,
      undefined,
      env,
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ tokenValid: true, email });
    await auth.api.resetPassword({ body: { token, newPassword: "Reset-password123" } });
    await expect(
      auth.api.signInEmail({ body: { email, password: "Reset-password123" } }),
    ).resolves.toMatchObject({ user: { email } });
    expect(
      (
        await app.request(
          `/reset-password-preview?token=${encodeURIComponent(token)}`,
          undefined,
          env,
        )
      ).status,
    ).toBe(400);
    await expect(
      auth.api.resetPassword({ body: { token, newPassword: "Reset-password123" } }),
    ).rejects.toMatchObject({ statusCode: 400 });
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
    expect(database.queries.some((sql) => /^delete from auth_users/i.test(sql))).toBe(false);
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
    const response = await auth.handler(
      new Request("https://api.opendfieldmap.org/auth/v1/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://opendfieldmap.org" },
        body: JSON.stringify({
          provider,
          callbackURL: "https://opendfieldmap.org",
          disableRedirect: true,
        }),
      }),
    );
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
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
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
    const callback = await auth.handler(new Request(callbackURL));
    expect(callback.status, JSON.stringify(vi.mocked(console.error).mock.calls)).toBe(302);
    expect(callback.headers.get("location")).toBe("https://opendfieldmap.org");
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
    await auth.handler(new Request(callbackURL));
    expect(count("auth_sessions")).toBe(1);
  });
});
