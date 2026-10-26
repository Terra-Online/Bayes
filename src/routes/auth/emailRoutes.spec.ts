import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth, runWithAuthRequest } from "@/lib/auth/createAuth";
import { onAppError } from "@/middleware/error-handler";
import emailTemplates from "@/services/email/templateLocales.json";
import { createMockBindings, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { insertUser } from "@/test/fixtures/users";
import type { AppEnv, Bindings } from "@/types/app";

import { createRoutes as createEmailRoutes } from "./emailRoutes";
import { createRoutes as createPasswordResetRoutes } from "./passwordResetRoutes";

vi.mock("@/lib/auth/rules/disposableEmailDomains.json", () => ({
  default: ["disposable.example.test"],
}));

interface RegisteredEmailIdentity {
  token: string;
  user: { id: string };
}

describe("email authentication HTTP behavior", () => {
  let database: TestDatabase;
  let env: Bindings;
  let app: Hono<AppEnv<{ requestId: string }>>;
  let delivery: MockBindings["idMails"]["send"];
  let testNumber = 0;
  let testIp: string;

  beforeEach(() => {
    database = createTestDatabase();
    vi.useFakeTimers({ toFake: ["Date"] });
    testIp = `198.51.100.${++testNumber}`;
    const external = createMockBindings({ DB: database.db });
    external.publicRateLimit.limit.mockResolvedValue({ success: true });
    delivery = external.idMails.send.mockResolvedValue({ messageId: "delivered" });
    env = {
      ...external.bindings,
      BETTER_AUTH_URL: "https://api.opendfieldmap.org",
      EMAIL_PROVIDER_MODE: "cloudflare_only",
      UPSTASH_REDIS_REST_URL: "https://redis.example.test",
    };
    // Only the external Redis endpoint is substituted. Rate limiting, auth,
    // templates, delivery orchestration and migrated SQLite remain real.
    const cooldowns = new Map<string, number>();
    const windows = new Map<string, Map<string, number>>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://redis.example.test/")) {
        throw new Error(`Unexpected external request: ${url}`);
      }
      const commands = JSON.parse(String(init?.body)) as [string, string, ...unknown[]][];
      return Response.json(
        commands.map(([command, key, ...args]) => {
          if (command === "set") {
            if ((cooldowns.get(key) ?? 0) > Date.now()) {
              return { result: null };
            }
            const ex = args.indexOf("ex");
            cooldowns.set(key, Date.now() + Number(args[ex + 1]) * 1000);
            return { result: "OK" };
          }
          if (command === "ttl") {
            return { result: Math.ceil(((cooldowns.get(key) ?? Date.now()) - Date.now()) / 1000) };
          }
          const entries = windows.get(key) ?? new Map<string, number>();
          windows.set(key, entries);
          if (command === "zremrangebyscore") {
            let removed = 0;
            for (const [member, score] of entries) {
              if (score >= Number(args[0]) && score <= Number(args[1])) {
                entries.delete(member);
                removed += 1;
              }
            }
            return { result: removed };
          }
          if (command === "zcard") {
            return { result: entries.size };
          }
          if (command === "zadd") {
            entries.set(String(args[1]), Number(args[0]));
            return { result: 1 };
          }
          if (command === "expire") {
            return { result: 1 };
          }
          throw new Error(`Unconfigured Redis command: ${command}`);
        }),
      );
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    app = new Hono<AppEnv<{ requestId: string }>>()
      .use(
        "*",
        createMiddleware<AppEnv>((_c, next) => runWithAuthRequest(next)),
      )
      .onError(onAppError);
    app.route("/auth/v1", createEmailRoutes());
    app.route("/auth/v1", createPasswordResetRoutes());
  });

  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function request(path: string, body: unknown, headers: HeadersInit = {}) {
    return app.request(
      `https://api.opendfieldmap.org/auth/v1${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://opendfieldmap.org",
          "cf-connecting-ip": testIp,
          ...headers,
        },
        body: JSON.stringify(body),
      },
      env,
    );
  }

  function storedIdentity() {
    return {
      users: database.sqlite.prepare("SELECT * FROM auth_users ORDER BY id").all(),
      accounts: database.sqlite.prepare("SELECT * FROM auth_accounts ORDER BY id").all(),
      sessions: database.sqlite.prepare("SELECT * FROM auth_sessions ORDER BY id").all(),
    };
  }

  async function issueOtp(email: string, locale?: string): Promise<string> {
    // Move beyond the recipient cooldown so each scenario receives a fresh code.
    vi.setSystemTime(Date.now() + 121_000);
    const response = await request("/email-otp/send-verification-otp", { email, locale });
    expect(response.status, await response.clone().text()).toBe(200);
    const message = delivery.mock.calls.at(-1)![0];
    if (!("text" in message) || typeof message.text !== "string") {
      throw new Error("Expected delivered OTP text");
    }
    return /\b\d{6}\b/.exec(message.text)![0];
  }

  async function registerEmailAccount(email: string): Promise<RegisteredEmailIdentity> {
    const response = await request("/register", {
      email,
      otp: await issueOtp(email),
      password: "Password123",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<RegisteredEmailIdentity>;
  }

  it("counts rejected OTP submissions toward the advertised IP budget and recovers after Retry-After", async () => {
    const first = await request("/email-otp/send-verification-otp", {});
    expect(first.status).toBe(422);
    const limit = Number(first.headers.get("x-ratelimit-limit"));
    expect(limit).toBeGreaterThan(0);
    for (let index = 1; index < limit; index++) {
      expect((await request("/email-otp/send-verification-otp", {})).status).toBe(422);
    }
    const payload = { email: "later@example.com" };
    const blocked = await request("/email-otp/send-verification-otp", payload);
    expect(blocked.status).toBe(429);
    const retryAfter = Number(blocked.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(delivery).not.toHaveBeenCalled();
    expect(storedIdentity()).toEqual({ users: [], accounts: [], sessions: [] });
    vi.setSystemTime(Date.now() + retryAfter * 1000 + 1);
    expect((await request("/email-otp/send-verification-otp", payload)).status).toBe(200);
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it("keeps a recipient's OTP budget across IPs and permits delivery after the window expires", async () => {
    const email = "budget@example.com";
    let exhausted = false;
    let delivered = 0;
    // Retry-After identifies the short cooldown. The recipient budget still blocks
    // after those cooldowns, even when every request comes from a different IP.
    // Bound the probe so removing the budget fails instead of looping indefinitely.
    for (let index = 0; index < 100; index++) {
      const response = await request(
        "/email-otp/send-verification-otp",
        { email: index % 2 ? " BUDGET@example.com " : email },
        { "cf-connecting-ip": `203.0.113.${index}` },
      );
      if (response.status === 200) {
        delivered++;
        continue;
      }
      expect(response.status).toBe(429);
      const retryAfter = Number(response.headers.get("retry-after"));
      if (retryAfter > 0) {
        vi.setSystemTime(Date.now() + retryAfter * 1000 + 1);
      } else {
        exhausted = true;
        break;
      }
    }
    expect(exhausted).toBe(true);
    expect(delivered).toBeGreaterThan(0);
    expect(delivery).toHaveBeenCalledTimes(delivered);
    expect(storedIdentity()).toEqual({ users: [], accounts: [], sessions: [] });
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    expect((await request("/email-otp/send-verification-otp", { email })).status).toBe(200);
    expect(delivery).toHaveBeenCalledTimes(delivered + 1);
  });

  it.each([
    ["ja", "fr-CA", "ja-JP"],
    [undefined, "fr-CA, en;q=0.8", "fr-FR"],
    [undefined, undefined, "de-DE"],
  ] as const)(
    "delivers the template selected by explicit locale %s, browser language %s, then deployment default",
    async (locale, browserLanguage, expectedLocale) => {
      env.EMAIL_TEMPLATE_DEFAULT_LOCALE = "de";
      const response = await request(
        "/email-otp/send-verification-otp",
        { email: "language@example.com", locale },
        browserLanguage ? { "accept-language": browserLanguage } : {},
      );
      expect(response.status).toBe(200);
      expect(delivery).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "language@example.com",
          subject: emailTemplates[expectedLocale].otp["email-verification"].subject,
        }),
      );
    },
  );

  it.each([
    [
      "/register",
      { email: "new@disposable.example.test", otp: "123456", password: "Password123" },
      "DISPOSABLE_EMAIL_NOT_ALLOWED",
    ],
    [
      "/email-otp/send-verification-otp",
      { email: "new@sub.disposable.example.test" },
      "DISPOSABLE_EMAIL_NOT_ALLOWED",
    ],
  ] as const)(
    "enforces the disposable-email registration policy at %s before creating an identity or sending mail",
    async (path, body, code) => {
      const before = storedIdentity();
      const response = await request(path, body);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code });
      expect(storedIdentity()).toEqual(before);
      expect(delivery).not.toHaveBeenCalled();
      expect(database.sqlite.prepare("SELECT * FROM auth_verifications").all()).toEqual([]);
    },
  );

  it("returns a validation response instead of forwarding a consumed email sign-in body", async () => {
    const response = await app.request(
      "https://api.opendfieldmap.org/auth/v1/sign-in/email",
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": testIp },
        body: "{",
      },
      env,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(storedIdentity()).toEqual({ users: [], accounts: [], sessions: [] });
    expect(delivery).not.toHaveBeenCalled();
  });

  it("keeps a registration OTP usable after password validation fails and permits normalized email sign-in", async () => {
    const email = "X@example.com";
    const otp = await issueOtp(email, "ja");
    expect(delivery.mock.calls.at(-1)![0]).toMatchObject({
      to: "x@example.com",
      subject: emailTemplates["ja-JP"].otp["email-verification"].subject,
      html: expect.stringContaining(otp),
    });
    const rejected = await request("/register", { email, otp, password: "weak" });
    expect(rejected.status).toBe(422);
    expect(storedIdentity()).toEqual({ users: [], accounts: [], sessions: [] });
    const registered = await request("/register", { email, otp, password: "Password123" });
    expect(registered.status).toBe(200);
    const identity = (await registered.json()) as { token: string; user: { id: string } };
    expect(storedIdentity().users).toEqual([
      expect.objectContaining({
        id: identity.user.id,
        email: "x@example.com",
        emailVerified: 1,
      }),
    ]);
    const before = storedIdentity();
    const wrongPassword = await request("/sign-in/email", {
      email: " X@EXAMPLE.COM ",
      password: "WrongPassword123",
    });
    expect(wrongPassword.status).toBe(401);
    expect(await wrongPassword.json()).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
    expect(storedIdentity()).toEqual(before);
    const signedIn = await request("/sign-in/email", {
      email: " X@EXAMPLE.COM ",
      password: "Password123",
    });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toMatchObject({
      user: { id: identity.user.id, email: "x@example.com" },
    });
  });

  it("recovers from failed OTP delivery without creating an account and registers with a newly delivered code", async () => {
    delivery.mockRejectedValueOnce(
      Object.assign(new Error("Mail service unavailable"), { code: "SEND_FAILED" }),
    );
    const failed = await request("/email-otp/send-verification-otp", {
      email: "retry@example.com",
    });
    // Better Auth acknowledges OTP requests even when the delivery callback
    // rejects. Recovery must use the subsequently delivered code.
    expect(failed.status).toBe(200);
    expect(await failed.text()).not.toContain("Mail service unavailable");
    expect(storedIdentity()).toEqual({ users: [], accounts: [], sessions: [] });
    const otp = await issueOtp("retry@example.com");
    const registered = await request("/register", {
      email: "retry@example.com",
      otp,
      password: "Password123",
      name: "Mail Traveler",
    });
    expect(registered.status).toBe(200);
    expect(await registered.json()).toMatchObject({
      user: { email: "retry@example.com", name: "Mail Traveler" },
    });
    expect(storedIdentity().users).toHaveLength(1);
    expect(storedIdentity().accounts).toHaveLength(1);
    expect(storedIdentity().sessions).toHaveLength(1);
  });

  it("retains an existing password, business profile and prior session when registration is repeated with fresh email proof", async () => {
    const email = "existing@example.com";
    const identity = await registerEmailAccount(email);
    insertUser(database.sqlite, {
      uid: identity.user.id,
      email,
      nickname: "Established",
      points: 340,
    });
    const beforeProfile = database.sqlite.prepare("SELECT * FROM users").all();
    const beforeAccounts = storedIdentity().accounts;
    const repeated = await request("/register", {
      email,
      otp: await issueOtp(email),
      password: "Different123",
      name: "Replacement",
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ user: { id: identity.user.id } });
    expect(storedIdentity().accounts).toEqual(beforeAccounts);
    expect(database.sqlite.prepare("SELECT * FROM users").all()).toEqual(beforeProfile);
    expect(storedIdentity().users).toHaveLength(1);
    await expect(
      createAuth(env).api.getSession({
        headers: new Headers({ authorization: `Bearer ${identity.token}` }),
      }),
    ).resolves.toMatchObject({ user: { id: identity.user.id } });
    expect((await request("/sign-in/email", { email, password: "Different123" })).status).toBe(401);
    expect((await request("/sign-in/email", { email, password: "Password123" })).status).toBe(200);
  });

  async function issueReset(email: string, locale?: string): Promise<string> {
    vi.setSystemTime(Date.now() + 121_000);
    const response = await request("/forget-password", {
      email,
      locale,
      redirectTo: "https://opendfieldmap.org/reset-password",
    });
    expect(response.status).toBe(200);
    const message = delivery.mock.calls.at(-1)![0];
    if (!("text" in message) || typeof message.text !== "string") {
      throw new Error("Expected delivered reset link");
    }
    return /https:\/\/api\.opendfieldmap\.org\/auth\/v1\/reset-password\/([^?\s]+)/.exec(
      message.text,
    )![1];
  }

  function preview(token: string) {
    return app.request(
      `https://api.opendfieldmap.org/auth/v1/reset-password-preview?token=${encodeURIComponent(token)}`,
      {
        headers: { "cf-connecting-ip": testIp },
      },
      env,
    );
  }

  it("preserves password and reset token after invalid reset input, then resets successfully using the localized delivered link", async () => {
    const email = "reset@example.com";
    await registerEmailAccount(email);
    const token = await issueReset("RESET@example.com", "zh-Hant");
    expect(delivery.mock.calls.at(-1)![0]).toMatchObject({
      to: email,
      subject: emailTemplates["zh-HK"].passwordResetMagicLink.subject,
      text: expect.stringContaining(token),
      html: expect.stringContaining(token),
    });
    const before = storedIdentity();
    for (const [newPassword, repeatPassword, status, code] of [
      ["weak", "weak", 422, "VALIDATION_ERROR"],
      ["ResetPassword123", "OtherPassword123", 400, "PASSWORD_MISMATCH"],
    ] as const) {
      const rejected = await request("/reset-password", { token, newPassword, repeatPassword });
      expect(rejected.status).toBe(status);
      expect(await rejected.json()).toMatchObject({ code });
      expect(storedIdentity()).toEqual(before);
      const valid = await preview(token);
      expect(valid.status).toBe(200);
      expect(await valid.json()).toMatchObject({ tokenValid: true, email });
    }
    const reset = await request("/reset-password", {
      token,
      newPassword: "ResetPassword123",
      repeatPassword: "ResetPassword123",
    });
    expect(reset.status).toBe(200);
    expect((await request("/sign-in/email", { email, password: "Password123" })).status).toBe(401);
    expect((await request("/sign-in/email", { email, password: "ResetPassword123" })).status).toBe(
      200,
    );
  });

  it("does not disclose whether a password-reset email belongs to an account", async () => {
    const response = await request("/forget-password", {
      email: "unknown@example.com",
      redirectTo: "https://opendfieldmap.org/reset-password",
    });
    expect(response.status).toBe(200);
    expect(delivery).not.toHaveBeenCalled();
    expect(storedIdentity()).toEqual({ users: [], accounts: [], sessions: [] });
    expect(database.sqlite.prepare("SELECT * FROM auth_verifications").all()).toEqual([]);
  });

  it("preserves the user's password and business profile after failed reset delivery and recovers with a newly delivered link", async () => {
    const email = "retry-reset@example.com";
    const { user } = await registerEmailAccount(email);
    insertUser(database.sqlite, { uid: user.id, email, nickname: "ResetOwner", points: 340 });
    const profile = database.sqlite.prepare("SELECT * FROM users").all();
    const before = storedIdentity();
    delivery.mockRejectedValueOnce(new Error("Mail service unavailable"));
    const failedDelivery = await request("/forget-password", {
      email,
      redirectTo: "https://opendfieldmap.org/reset-password",
    });
    expect(failedDelivery.status).toBe(200); // Better Auth keeps its non-disclosing acknowledgement.
    expect(storedIdentity()).toEqual(before);
    expect(database.sqlite.prepare("SELECT * FROM users").all()).toEqual(profile);
    const token = await issueReset(email);
    const reset = await request("/reset-password", {
      token,
      newPassword: "ResetPassword123",
      repeatPassword: "ResetPassword123",
    });
    expect(reset.status).toBe(200);
    expect((await request("/sign-in/email", { email, password: "ResetPassword123" })).status).toBe(
      200,
    );
    expect(database.sqlite.prepare("SELECT * FROM users").all()).toEqual(profile);
    expect(storedIdentity().users).toHaveLength(1);
  });

  it.each(["expired", "deleted user"])(
    "rejects reset previews for an %s token without changing surviving accounts",
    async (state) => {
      const email = "preview@example.com";
      await registerEmailAccount(email);
      const token = await issueReset(email);
      if (state === "expired") {
        database.sqlite
          .prepare("UPDATE auth_verifications SET expiresAt = ? WHERE identifier = ?")
          .run("2020-01-01T00:00:00.000Z", `reset-password:${token}`);
      } else {
        // Verification values have no user FK; deleting an account can leave a
        // still-live reset token referring to that removed identity.
        database.sqlite.exec(
          "DELETE FROM auth_sessions; DELETE FROM auth_accounts; DELETE FROM auth_users;",
        );
      }
      const before = storedIdentity();
      const response = await preview(token);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_TOKEN" });
      expect(storedIdentity()).toEqual(before);
    },
  );
});
