import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTH_EXCHANGE_CHALLENGE_PARAM } from "@/lib/auth/browserSession";
import type { TestDatabase } from "@/test/database/createTestDatabase";
import {
  createSessionAuthFixture,
  loginWithGithub,
  type SessionAuthFixture,
} from "@/test/fixtures/sessionAuth";
import type { AppEnv, Bindings } from "@/types/app";

interface IssuedExchangeCode {
  code: string;
  cookie: string;
  token: string;
}

const API_ORIGIN = "https://api.opendfieldmap.org";
const CN_API_ORIGIN = "https://api.opendfieldmap.cn";
const CN_ORIGIN = "https://opendfieldmap.cn";

describe("CHIPS OAuth exchange", () => {
  let database: TestDatabase;
  let env: Bindings;
  let app: Hono<AppEnv<{ requestId: string }>>;
  let fixture: SessionAuthFixture;
  let proofCookie: string;
  let callbackUrl: string;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Only JS time advances. SQLite CURRENT_TIMESTAMP remains wall-clock time;
    // these tests assert auth timestamps, never users.last_active.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-05T00:00:00.000Z"));
    fixture = createSessionAuthFixture(API_ORIGIN);
    ({ database, env, app } = fixture);
  });

  afterEach(() => {
    database.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function issueCode(
    origin = CN_ORIGIN,
    apiOrigin = API_ORIGIN,
  ): Promise<IssuedExchangeCode> {
    const {
      initiated,
      callback: response,
      cookie,
      token,
    } = await loginWithGithub(fixture, origin, apiOrigin);
    const proof = initiated.headers
      .getSetCookie()
      .find((value) => value.includes(".oauth_exchange_proof="))!;
    expect(proof).toContain("Partitioned");
    expect(proof).toContain("HttpOnly");
    proofCookie = proof.split(";")[0]!;
    callbackUrl = response.headers.get("location")!;
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const destination = new URL(callbackUrl);
    const code = destination.searchParams.get("auth_code")!;
    expect(code).toBeTruthy();
    // The browser proof stays in its HttpOnly cookie, outside the frontend URL.
    expect(destination.searchParams.has(AUTH_EXCHANGE_CHALLENGE_PARAM)).toBe(false);
    return { code, cookie, token };
  }

  function exchange(code: string, origin: string | null = CN_ORIGIN, apiOrigin = API_ORIGIN) {
    const headers = new Headers({ "content-type": "application/json" });
    if (proofCookie) {
      headers.set("cookie", proofCookie);
    }
    if (origin) {
      headers.set("origin", origin);
    }
    return app.request(
      `${apiOrigin}/auth/v1/session/exchange`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ code }),
      },
      env,
    );
  }

  it.each([CN_ORIGIN, "https://opendfieldmap.org", "https://www.opendfieldmap.cn"])(
    "establishes a signed HttpOnly partitioned cookie from %s without relying on callback cookies",
    async (origin) => {
      const { code, token } = await issueCode(origin);
      const response = await exchange(code, origin);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const payload = (await response.json()) as { user: { uid: string }; token?: string };
      expect(payload.user.uid).toBe("100001ER");
      expect(payload).not.toHaveProperty("token");
      expect(JSON.stringify(payload)).not.toContain(token);
      const cookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith("__Secure-oem-chips.session_token="))!;
      for (const attribute of [
        "Secure",
        "HttpOnly",
        "SameSite=None",
        "Partitioned",
        "Max-Age=15552000",
        "Path=/",
      ]) {
        expect(cookie).toContain(attribute);
      }
      expect(cookie).not.toContain("Domain=");
      const session = await app.request(
        `${API_ORIGIN}/auth/v1/session`,
        {
          headers: { origin, cookie: cookie.split(";")[0]! },
        },
        env,
      );
      expect(session.status).toBe(200);
    },
  );

  it("establishes the CN session through api.opendfieldmap.cn after the frontend callback", async () => {
    const { code } = await issueCode(CN_ORIGIN, CN_API_ORIGIN);
    const established = await exchange(code, CN_ORIGIN, CN_API_ORIGIN);
    expect(established.status).toBe(200);
    const cookie = established.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Secure-oem-chips.session_token="))!;
    expect(cookie).toBeTruthy();
    expect(callbackUrl.startsWith(CN_ORIGIN + "/")).toBe(true);

    const session = await app.request(
      CN_API_ORIGIN + "/auth/v1/session",
      {
        headers: { origin: CN_ORIGIN, cookie: cookie.split(";")[0]! },
      },
      env,
    );
    expect(session.status).toBe(200);
  });

  it("consumes a code once, including concurrent attempts", async () => {
    const { code } = await issueCode();
    const results = await Promise.all([exchange(code), exchange(code)]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
    expect((await exchange(code)).status).toBe(400);
  });

  it.each([null, "https://untrusted.example"])(
    "does not seed a login proof for an untrusted origin %s",
    async (origin) => {
      const headers = new Headers({ "content-type": "application/json", referer: `${CN_ORIGIN}/` });
      if (origin) {
        headers.set("origin", origin);
      }
      const response = await app.request(
        `${API_ORIGIN}/auth/v1/sign-in/social`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            provider: "github",
            callbackURL: CN_ORIGIN,
            disableRedirect: true,
          }),
        },
        env,
      );
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toEqual([]);
    },
  );

  it("rejects a stolen code without the initiating browser's partitioned proof cookie", async () => {
    const { code } = await issueCode();
    const originalProof = proofCookie;
    proofCookie = "";
    expect((await exchange(code)).status).toBe(400);
    proofCookie = originalProof;
    expect((await exchange(code)).status).toBe(200);
  });

  it("preserves the exchange code after malformed JSON and an oversized browser proof", async () => {
    const { code } = await issueCode();
    const response = await app.request(
      `${API_ORIGIN}/auth/v1/session/exchange`,
      {
        method: "POST",
        headers: { origin: CN_ORIGIN, "content-type": "application/json", cookie: proofCookie },
        body: "{",
      },
      env,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(response.headers.getSetCookie()).toEqual([]);
    const original = proofCookie;
    proofCookie = `${proofCookie.split("=")[0]}=${"a".repeat(129)}`;
    expect((await exchange(code)).status).toBe(400);
    proofCookie = original;
    expect((await exchange(code)).status).toBe(200);
    expect((await exchange(code)).status).toBe(400);
  });

  it.each([
    ["/settings?tab=accounts", `${CN_ORIGIN}/settings?tab=accounts`],
    ["//attacker.example/steal", `${CN_ORIGIN}/`],
    ["/\\attacker.example/steal", `${CN_ORIGIN}/`],
    ["https://attacker.example/steal", `${CN_ORIGIN}/`],
    ["not a URL", `${CN_ORIGIN}/`],
  ])("keeps OAuth return destinations trusted for %s", async (callbackURL, expected) => {
    const response = await app.request(
      `${API_ORIGIN}/auth/v1/sign-in/social`,
      {
        method: "POST",
        headers: { origin: CN_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          callbackURL,
          newUserCallbackURL: callbackURL,
          errorCallbackURL: callbackURL,
          disableRedirect: true,
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    const row = database.sqlite.prepare("SELECT value FROM auth_verifications").get()!;
    const stored = JSON.parse(String(row.value)) as {
      callbackURL: string;
      newUserURL: string;
      errorURL: string;
    };
    for (const raw of [stored.callbackURL, stored.newUserURL, stored.errorURL]) {
      const url = new URL(raw);
      url.searchParams.delete(AUTH_EXCHANGE_CHALLENGE_PARAM);
      expect(url.toString()).toBe(expected);
    }
    expect(database.sqlite.prepare("SELECT id FROM auth_sessions").all()).toEqual([]);
  });

  it("uses explicitly configured frontend origins while excluding the backend itself", async () => {
    env.TRUSTED_ORIGINS = `${API_ORIGIN}, https://preview.example.test, `;
    const response = await app.request(
      `${API_ORIGIN}/auth/v1/sign-in/social`,
      {
        method: "POST",
        headers: { origin: "https://preview.example.test", "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: "/map", disableRedirect: true }),
      },
      env,
    );
    expect(response.status).toBe(200);
    const row = database.sqlite.prepare("SELECT value FROM auth_verifications").get()!;
    expect(JSON.parse(String(row.value)).callbackURL).toMatch(
      /^https:\/\/preview\.example\.test\/map\?/,
    );
    const rejected = await app.request(
      `${API_ORIGIN}/auth/v1/sign-in/social`,
      {
        method: "POST",
        headers: { origin: API_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", disableRedirect: true }),
      },
      env,
    );
    expect(rejected.status).toBe(403);
    expect(database.sqlite.prepare("SELECT id FROM auth_verifications").all()).toHaveLength(1);
  });

  it("rejects a code paired with a different browser login attempt", async () => {
    const { code } = await issueCode();
    const originalProof = proofCookie;
    const otherBrowser = await app.request(
      `${API_ORIGIN}/auth/v1/sign-in/social`,
      {
        method: "POST",
        headers: { origin: CN_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: CN_ORIGIN, disableRedirect: true }),
      },
      env,
    );
    expect(otherBrowser.status).toBe(200);
    proofCookie = otherBrowser.headers
      .getSetCookie()
      .find((value) => value.includes(".oauth_exchange_proof="))!
      .split(";")[0]!;
    expect((await exchange(code)).status).toBe(400);
    proofCookie = originalProof;
    expect((await exchange(code)).status).toBe(200);
  });

  it("binds the code to the frontend origin without consuming it on a wrong-origin attempt", async () => {
    const { code } = await issueCode();
    expect((await exchange(code, "https://opendfieldmap.org")).status).toBe(400);
    expect((await exchange(code)).status).toBe(200);
  });

  it.each([null, "null", "https://untrusted.example"])(
    "rejects origin %s before consuming the code",
    async (origin) => {
      const { code } = await issueCode();
      expect((await exchange(code, origin)).status).toBe(403);
      expect((await exchange(code)).status).toBe(200);
    },
  );

  it("does not exchange an expired code", async () => {
    const { code } = await issueCode();
    vi.setSystemTime(Date.now() + 121_000);
    const response = await exchange(code);
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("does not restore a revoked session", async () => {
    const { code, cookie } = await issueCode();
    const signedOut = await app.request(
      `${API_ORIGIN}/auth/v1/sign-out`,
      {
        method: "POST",
        headers: {
          origin: CN_ORIGIN,
          cookie: cookie.split(";")[0]!,
          "content-type": "application/json",
        },
        body: "{}",
      },
      env,
    );
    expect(signedOut.status).toBe(200);
    const response = await exchange(code);
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("does not consume the exchange code when its session is temporarily unavailable", async () => {
    const { code } = await issueCode();
    database.sqlite.exec(
      "CREATE TEMP TABLE saved_session AS SELECT * FROM auth_sessions; DELETE FROM auth_sessions",
    );
    expect((await exchange(code)).status).toBe(401);

    database.sqlite.exec("INSERT INTO auth_sessions SELECT * FROM saved_session");
    expect((await exchange(code)).status).toBe(200);
    expect((await exchange(code)).status).toBe(400);
  });

  it("does not give the exchanged cookie a longer lifetime than the stored session", async () => {
    const { code } = await issueCode();
    database.sqlite
      .prepare("UPDATE auth_sessions SET expiresAt = ?")
      .run(new Date(Date.now() + 3_600_000).toISOString());
    const response = await exchange(code);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=3600");
  });

  it.each([false, true])(
    "signs out and clears both cookie generations (legacy-only: %s)",
    async (legacyOnly) => {
      const { code, cookie: originalCookie } = await issueCode();
      const established = await exchange(code);
      const cookie = established.headers.getSetCookie()[0]!;
      const legacyCookie = originalCookie
        .split(";")[0]!
        .replace("__Secure-oem-chips.", "__Secure-better-auth.");
      const requestCookie = legacyOnly ? legacyCookie : `${legacyCookie}; ${cookie.split(";")[0]}`;
      const response = await app.request(
        `${API_ORIGIN}/auth/v1/sign-out`,
        {
          method: "POST",
          headers: { origin: CN_ORIGIN, cookie: requestCookie, "content-type": "application/json" },
          body: "{}",
        },
        env,
      );
      expect(response.status).toBe(200);
      const cleared = response.headers.getSetCookie();
      const partitionedCookie = cleared.find((value) =>
        value.startsWith("__Secure-oem-chips.session_token="),
      );
      expect(partitionedCookie).toContain("Partitioned");
      expect(partitionedCookie).toContain("Max-Age=0");
      const oldCookie = cleared.find((value) =>
        value.startsWith("__Secure-better-auth.session_token="),
      )!;
      expect(oldCookie).toContain("Max-Age=0");
      expect(oldCookie).not.toContain("Partitioned");
      expect(
        (
          await app.request(
            `${API_ORIGIN}/auth/v1/session`,
            { headers: { cookie: requestCookie } },
            env,
          )
        ).status,
      ).toBe(401);
    },
  );
});
