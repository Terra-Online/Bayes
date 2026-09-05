import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getCookies } from "better-auth/cookies";
import { Hono } from "hono";
import { createAuth } from "../../lib/auth/createAuth";
import { resolveAuthIdentity } from "../../middleware/auth";
import { onAppError } from "../../middleware/error-handler";
import type { AppEnv, Bindings } from "../../types/app";
import { registerSessionAuthRoutes } from "./sessionRoutes";

vi.mock("../../lib/auth/createAuth", () => ({ createAuth: vi.fn() }));
vi.mock("../../lib/email/sender", () => ({ initResend: vi.fn(), sendEmail: vi.fn() }));
vi.mock("../../lib/auth/providers", () => ({ createAuthSocialProviders: () => ({}) }));
vi.mock("../../middleware/rate-limit", () => ({
  rateLimit: () => async (_context: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../../repositories/users", () => ({
  ensureUserProfile: vi.fn(async (_database: unknown, identity: { uid: string; email: string }) => ({
    ...identity,
    uidNumber: 1,
    uidSuffix: "test",
    role: "n",
    karma: 0,
    avt: 1,
    nickname: "Tester",
    createdAt: "2026-09-05T00:00:00.000Z",
    nicknameCustomized: true,
  })),
  formatPublicUid: () => "1-test",
  getErrorMessage: (error: Error) => error.message,
  updateUserNickname: vi.fn(),
}));

const realCreateAuth = (await vi.importActual<typeof import("../../lib/auth/createAuth")>(
  "../../lib/auth/createAuth"
)).createAuth;
const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.parse("2026-09-05T00:00:00.000Z");

describe.each(["http://localhost:8787", "https://api.opendfieldmap.org"])("persistent browser sessions at %s", (baseURL) => {
  let database: Record<string, Record<string, unknown>[]>;
  let env: Bindings;
  let auth: ReturnType<typeof createAuth>;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START_MS);
    database = { auth_users: [], auth_sessions: [], auth_accounts: [], auth_verifications: [] };
    env = {
      DB: memoryAdapter(database) as unknown as D1Database,
      BETTER_AUTH_SECRET: "test-only-session-secret-at-least-32-characters",
      BETTER_AUTH_URL: baseURL,
    } as Bindings;
    auth = realCreateAuth(env);
    vi.mocked(createAuth).mockReturnValue(auth);
    app = new Hono<AppEnv>();
    app.onError(onAppError);
    registerSessionAuthRoutes(app);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function signIn() {
    const result = await auth.api.signUpEmail({
      body: { email: "session@example.com", password: "test-password-12345", name: "Tester" },
      returnHeaders: true,
    });
    const cookie = result.headers.getSetCookie().find((value) => value.startsWith(`${getCookies(auth.options).sessionToken.name}=`))!;
    return { cookie, headers: new Headers({ cookie: cookie.split(";")[0]! }) };
  }

  function sessionRecord() {
    return database.auth_sessions![0]!;
  }

  it("uses a 180-day persistent, HttpOnly cookie and a one-day update age", async () => {
    expect(auth.options.session).toMatchObject({ expiresIn: 15_552_000, updateAge: 86_400 });
    const { cookie } = await signIn();
    expect(cookie).toContain("Max-Age=15552000");
    expect(cookie).toContain("HttpOnly");
    if (baseURL.startsWith("https:")) {
      expect(cookie).toContain("__Secure-oem-chips.session_token=");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=None");
      expect(cookie).toContain("Partitioned");
      expect(cookie).not.toContain("Domain=");
    } else {
      expect(cookie).not.toContain("Partitioned");
    }
    expect(sessionRecord().expiresAt).toEqual(new Date(START_MS + 180 * DAY_MS));
  });

  it("honors the configured TTL and keeps renewal possible for short overrides", () => {
    const configured = realCreateAuth({ ...env, SESSION_TTL_SECONDS: "3600" });
    expect(configured.options.session).toMatchObject({ expiresIn: 3600, updateAge: 1800 });
    const invalid = realCreateAuth({ ...env, SESSION_TTL_SECONDS: "invalid" });
    expect(invalid.options.session?.expiresIn).toBe(15_552_000);
  });

  it("renews both database and browser on repeated 40-day returns, beyond the original expiry", async () => {
    let { headers } = await signIn();
    for (const visitDay of [40, 80, 120, 160, 200, 240, 280, 320, 360, 400]) {
      vi.setSystemTime(START_MS + visitDay * DAY_MS);
      const previousExpiry = sessionRecord().expiresAt;
      await resolveAuthIdentity(env, headers);
      expect(sessionRecord().expiresAt).toEqual(previousExpiry);

      const response = await app.request("/session", { headers }, env);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const renewedCookie = response.headers.getSetCookie().find((value) => value.startsWith(`${getCookies(auth.options).sessionToken.name}=`))!;
      expect(renewedCookie).toContain("Max-Age=15552000");
      if (baseURL.startsWith("https:")) expect(renewedCookie).toContain("Partitioned");
      expect(sessionRecord().expiresAt).toEqual(new Date(START_MS + (visitDay + 180) * DAY_MS));
      headers = new Headers({ cookie: renewedCookie.split(";")[0]! });
    }
  });

  it("does not renew repeatedly within a day", async () => {
    const { headers } = await signIn();
    vi.setSystemTime(START_MS + DAY_MS);
    const first = await app.request("/session", { headers }, env);
    expect(first.headers.getSetCookie().length).toBeGreaterThan(0);
    const expiry = sessionRecord().expiresAt;
    vi.setSystemTime(START_MS + DAY_MS + 15 * 60 * 1000);
    const second = await app.request("/session", { headers }, env);
    expect(second.status).toBe(200);
    expect(second.headers.getSetCookie()).toEqual([]);
    expect(sessionRecord().expiresAt).toEqual(expiry);
  });

  it.each(["bearer", "query"])("preserves %s token authentication on the session endpoint", async (transport) => {
    await signIn();
    const token = String(sessionRecord().token);
    vi.setSystemTime(START_MS + 40 * DAY_MS);
    const path = transport === "query" ? `/session?access_token=${encodeURIComponent(token)}` : "/session";
    const headers = transport === "bearer" ? { authorization: `Bearer ${token}` } : undefined;
    const response = await app.request(path, { headers }, env);
    expect(response.status).toBe(200);
    expect(sessionRecord().expiresAt).toEqual(new Date(START_MS + 220 * DAY_MS));
  });

  it("upgrades a still-valid seven-day session on its next visit", async () => {
    const { headers } = await signIn();
    sessionRecord().expiresAt = new Date(START_MS + 7 * DAY_MS);
    const response = await app.request("/session", { headers }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=15552000");
    expect(sessionRecord().expiresAt).toEqual(new Date(START_MS + 180 * DAY_MS));
  });

  it("silently migrates a valid legacy cookie without revoking it before browser confirmation", async () => {
    if (!baseURL.startsWith("https:")) return;
    const { cookie } = await signIn();
    const legacyCookie = cookie.split(";")[0]!.replace("__Secure-oem-chips.", "__Secure-better-auth.");
    const sessionId = sessionRecord().id;
    const migrated = await app.request("/session", { headers: { cookie: legacyCookie } }, env);
    expect(migrated.status).toBe(200);
    expect(await migrated.json()).toMatchObject({ requiresCookieConfirmation: true });
    const migratedCookie = migrated.headers.getSetCookie().find((value) => value.startsWith("__Secure-oem-chips.session_token="))!;
    expect(migratedCookie).toContain("Partitioned");
    expect(migratedCookie).toContain("Max-Age=15552000");
    expect(migrated.headers.getSetCookie().some((value) => value.startsWith("__Secure-better-auth.session_token="))).toBe(false);
    expect(sessionRecord().id).toBe(sessionId);
    const response = await app.request("/session", {
      headers: { cookie: `${legacyCookie}; ${migratedCookie.split(";")[0]}` },
    }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("requiresCookieConfirmation");
    const retiredCookie = response.headers.getSetCookie().find((value) => value.startsWith("__Secure-better-auth.session_token="))!;
    expect(retiredCookie).toContain("Max-Age=0");
    expect(retiredCookie).not.toContain("Partitioned");
    expect(sessionRecord().id).toBe(sessionId);
  });

  it.each(["; ", ";"])("never falls back to an old account when a new cookie is invalid (separator %j)", async (separator) => {
    if (!baseURL.startsWith("https:")) return;
    const { cookie } = await signIn();
    const legacyCookie = cookie.split(";")[0]!.replace("__Secure-oem-chips.", "__Secure-better-auth.");
    const response = await app.request("/session", {
      headers: { cookie: `${legacyCookie}${separator}__Secure-oem-chips.session_token=invalid` },
    }, env);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie") ?? "").not.toContain("Max-Age=15552000");
  });

  it("does not migrate a forged legacy signature", async () => {
    if (!baseURL.startsWith("https:")) return;
    await signIn();
    const response = await app.request("/session", {
      headers: { cookie: `__Secure-better-auth.session_token=${String(sessionRecord().token)}.forged` },
    }, env);
    expect(response.status).toBe(401);
  });

  it("does not revive an expired session", async () => {
    const { headers } = await signIn();
    vi.setSystemTime(START_MS + 181 * DAY_MS);
    const response = await app.request("/session", { headers }, env);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie") ?? "").not.toContain("Max-Age=15552000");
  });

  it("rejects a revoked session even while the middleware user cache is warm", async () => {
    const { headers } = await signIn();
    expect((await app.request("/session", { headers }, env)).status).toBe(200);
    await auth.api.signOut({ headers });
    const response = await app.request("/session", { headers }, env);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie") ?? "").not.toContain("Max-Age=15552000");
  });
});
