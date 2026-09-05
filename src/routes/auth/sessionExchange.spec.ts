import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getCookies } from "better-auth/cookies";
import { Hono } from "hono";
import { createAuth } from "../../lib/auth/createAuth";
import { AUTH_EXCHANGE_CHALLENGE_PARAM, createOAuthExchangeProof, getLegacyCookieExpirations } from "../../lib/auth/browserSession";
import { onAppError } from "../../middleware/error-handler";
import type { AppEnv, Bindings } from "../../types/app";
import { attachSessionExchangeCode } from "./callbacks";
import { forwardToAuthRawRequest } from "./forwarding";
import { handleSessionExchange } from "./sessionExchange";
import { registerSessionAuthRoutes } from "./sessionRoutes";
import { registerSocialAuthRoutes } from "./socialRoutes";

vi.mock("../../lib/auth/createAuth", () => ({ createAuth: vi.fn() }));
vi.mock("../../lib/email/sender", () => ({ initResend: vi.fn(), sendEmail: vi.fn() }));
vi.mock("../../lib/auth/providers", () => ({ createAuthSocialProviders: () => ({}) }));
vi.mock("../../middleware/rate-limit", () => ({
  rateLimit: () => async (_context: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../../repositories/users", () => ({
  ensureUserProfile: vi.fn(async (_database: unknown, identity: { uid: string; email: string }) => ({
    ...identity, uidNumber: 1, uidSuffix: "test", role: "n", karma: 0, avt: 1,
    nickname: "Tester", createdAt: "2026-09-05T00:00:00.000Z", nicknameCustomized: true,
  })),
  formatPublicUid: () => "1-test",
  getErrorMessage: (error: Error) => error.message,
  updateUserNickname: vi.fn(),
}));

const realCreateAuth = (await vi.importActual<typeof import("../../lib/auth/createAuth")>("../../lib/auth/createAuth")).createAuth;
const API_ORIGIN = "https://api.opendfieldmap.org";
const CN_ORIGIN = "https://opendfieldmap.cn";

describe("CHIPS OAuth exchange", () => {
  let sqlite: DatabaseSync;
  let auth: ReturnType<typeof createAuth>;
  let env: Bindings;
  let app: Hono<AppEnv>;
  let authDatabase: Record<string, Record<string, unknown>[]>;
  let proofCookie: string;
  let callbackUrl: string;
  let callbackCookie: string;

  beforeEach(() => {
    const NativeRequest = Request;
    vi.stubGlobal("Request", class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        const options = { ...init, duplex: "half" };
        super(input, options);
      }
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-05T00:00:00.000Z"));
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE auth_verifications (id TEXT PRIMARY KEY, identifier TEXT UNIQUE, value TEXT, expiresAt TEXT, createdAt TEXT, updatedAt TEXT)");
    const database = {
      prepare(query: string) {
        return {
          bind(...values: SQLInputValue[]) {
            return {
              async first() { return sqlite.prepare(query).get(...values) ?? null; },
              async run() { return sqlite.prepare(query).run(...values); },
            };
          },
        };
      },
    };
    env = {
      DB: database as unknown as D1Database,
      BETTER_AUTH_SECRET: "test-only-chips-secret-at-least-32-characters",
      BETTER_AUTH_URL: API_ORIGIN,
    } as Bindings;
    authDatabase = { auth_users: [], auth_sessions: [], auth_accounts: [], auth_verifications: [] };
    auth = realCreateAuth({ ...env, DB: memoryAdapter(authDatabase) as unknown as D1Database });
    vi.mocked(createAuth).mockReturnValue(auth);
    app = new Hono<AppEnv>();
    app.onError(onAppError);
    app.get("/test-callback", (context) => attachSessionExchangeCode(context, new Response(null, {
      status: 302,
      headers: { location: callbackUrl, "set-cookie": callbackCookie },
    })));
    app.post("/session/exchange", handleSessionExchange);
    registerSessionAuthRoutes(app);
    registerSocialAuthRoutes(app, {
      forwardToAuthJsonPath: async (_context, _path, body) => {
        callbackUrl = String(body.callbackURL);
        expect(body.newUserCallbackURL).toBe(body.callbackURL);
        return new Response(JSON.stringify({ url: "https://provider.example/authorize" }), {
          headers: { "content-type": "application/json" },
        });
      },
      forwardToAuthRawRequest,
    });
    app.post("/auth/v1/sign-out", async (context) => {
      const response = await forwardToAuthRawRequest(context);
      if (response.ok) {
        for (const cookie of getLegacyCookieExpirations(auth)) response.headers.append("Set-Cookie", cookie);
      }
      return response;
    });
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function issueCode(origin = CN_ORIGIN) {
    const initiated = await app.request(`${API_ORIGIN}/sign-in/social`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", callbackURL: `${origin}/?test=1`, disableRedirect: true }),
    }, env);
    expect(initiated.status).toBe(200);
    const proof = initiated.headers.getSetCookie().find((value) => value.includes(".oauth_exchange_proof="))!;
    expect(proof).toContain("Partitioned");
    expect(proof).toContain("HttpOnly");
    proofCookie = proof.split(";")[0]!;
    const result = await auth.api.signUpEmail({
      body: { email: `${crypto.randomUUID()}@example.com`, password: "test-password-12345", name: "Tester" },
      returnHeaders: true,
    });
    const cookieName = getCookies(auth.options).sessionToken.name;
    const cookie = result.headers.getSetCookie().find((value) => value.startsWith(`${cookieName}=`))!;
    callbackCookie = cookie;
    const response = await app.request(`${API_ORIGIN}/test-callback`, {}, env);
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const code = new URL(response.headers.get("location")!).searchParams.get("auth_code")!;
    expect(code).toBeTruthy();
    expect(new URL(response.headers.get("location")!).searchParams.has(AUTH_EXCHANGE_CHALLENGE_PARAM)).toBe(false);
    return { code, cookie, token: result.response.token };
  }

  function exchange(code: string, origin: string | null = CN_ORIGIN) {
    const headers = new Headers({ "content-type": "application/json" });
    if (proofCookie) headers.set("cookie", proofCookie);
    if (origin) headers.set("origin", origin);
    return app.request(`${API_ORIGIN}/session/exchange`, {
      method: "POST", headers, body: JSON.stringify({ code }),
    }, env);
  }

  it.each([CN_ORIGIN, "https://opendfieldmap.org", "https://www.opendfieldmap.cn"])(
    "establishes a signed HttpOnly partitioned cookie from %s without relying on callback cookies",
    async (origin) => {
      const { code, token } = await issueCode(origin);
      const response = await exchange(code, origin);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const payload = await response.json() as { user: { uid: string }; token?: string };
      expect(payload.user.uid).toBe("1-test");
      expect(payload).not.toHaveProperty("token");
      expect(JSON.stringify(payload)).not.toContain(token!);
      const cookie = response.headers.getSetCookie().find((value) => value.startsWith("__Secure-oem-chips.session_token="))!;
      for (const attribute of ["Secure", "HttpOnly", "SameSite=None", "Partitioned", "Max-Age=15552000", "Path=/"]) {
        expect(cookie).toContain(attribute);
      }
      expect(cookie).not.toContain("Domain=");
      const session = await app.request(`${API_ORIGIN}/session`, {
        headers: { origin, cookie: cookie.split(";")[0]! },
      }, env);
      expect(session.status).toBe(200);
    },
  );

  it("consumes a code once, including concurrent attempts", async () => {
    const { code } = await issueCode();
    const results = await Promise.all([exchange(code), exchange(code)]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
    expect((await exchange(code)).status).toBe(400);
  });

  it.each([null, "https://untrusted.example"])("does not seed a login proof for an untrusted origin %s", async (origin) => {
    const headers = new Headers({ "content-type": "application/json", referer: `${CN_ORIGIN}/` });
    if (origin) headers.set("origin", origin);
    const response = await app.request(`${API_ORIGIN}/sign-in/social`, {
      method: "POST", headers,
      body: JSON.stringify({ provider: "github", callbackURL: CN_ORIGIN, disableRedirect: true }),
    }, env);
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("rejects a stolen code without the initiating browser's partitioned proof cookie", async () => {
    const { code } = await issueCode();
    const originalProof = proofCookie;
    proofCookie = "";
    expect((await exchange(code)).status).toBe(400);
    proofCookie = originalProof;
    expect((await exchange(code)).status).toBe(200);
  });

  it("rejects a code paired with a different browser login attempt", async () => {
    const { code } = await issueCode();
    const originalProof = proofCookie;
    proofCookie = (await createOAuthExchangeProof(auth)).cookie.split(";")[0]!;
    expect((await exchange(code)).status).toBe(400);
    proofCookie = originalProof;
    expect((await exchange(code)).status).toBe(200);
  });

  it("binds the code to the frontend origin without consuming it on a wrong-origin attempt", async () => {
    const { code } = await issueCode();
    expect((await exchange(code, "https://opendfieldmap.org")).status).toBe(400);
    expect((await exchange(code)).status).toBe(200);
  });

  it.each([null, "null", "https://untrusted.example"])("rejects origin %s before consuming the code", async (origin) => {
    const { code } = await issueCode();
    expect((await exchange(code, origin)).status).toBe(403);
    expect((await exchange(code)).status).toBe(200);
  });

  it("does not exchange an expired code", async () => {
    const { code } = await issueCode();
    vi.setSystemTime(Date.now() + 121_000);
    const response = await exchange(code);
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("does not restore a revoked session", async () => {
    const { code, cookie } = await issueCode();
    await auth.api.signOut({ headers: new Headers({ cookie: cookie.split(";")[0]! }) });
    const response = await exchange(code);
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("does not give the exchanged cookie a longer lifetime than the stored session", async () => {
    const { code } = await issueCode();
    authDatabase.auth_sessions![0]!.expiresAt = new Date(Date.now() + 3_600_000);
    const response = await exchange(code);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=3600");
  });

  it.each([false, true])("signs out and clears both cookie generations (legacy-only: %s)", async (legacyOnly) => {
    const { code, cookie: originalCookie } = await issueCode();
    const established = await exchange(code);
    const cookie = established.headers.getSetCookie()[0]!;
    const legacyCookie = originalCookie.split(";")[0]!.replace("__Secure-oem-chips.", "__Secure-better-auth.");
    const requestCookie = legacyOnly ? legacyCookie : `${legacyCookie}; ${cookie.split(";")[0]}`;
    const response = await app.request(`${API_ORIGIN}/auth/v1/sign-out`, {
      method: "POST", headers: { origin: CN_ORIGIN, cookie: requestCookie, "content-type": "application/json" }, body: "{}",
    }, env);
    expect(response.status).toBe(200);
    const cleared = response.headers.getSetCookie();
    expect(cleared.find((value) => value.startsWith("__Secure-oem-chips.session_token="))).toContain("Partitioned");
    expect(cleared.find((value) => value.startsWith("__Secure-oem-chips.session_token="))).toContain("Max-Age=0");
    const oldCookie = cleared.find((value) => value.startsWith("__Secure-better-auth.session_token="))!;
    expect(oldCookie).toContain("Max-Age=0");
    expect(oldCookie).not.toContain("Partitioned");
    expect((await app.request(`${API_ORIGIN}/session`, { headers: { cookie: requestCookie } }, env)).status).toBe(401);
  });
});
