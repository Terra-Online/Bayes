import { getCookies } from "better-auth/cookies";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as authModule from "@/lib/auth/createAuth";
import { createAuth, runWithAuthRequest } from "@/lib/auth/createAuth";
import { resolveAuthIdentity } from "@/middleware/auth";
import type { TestDatabase } from "@/test/database/createTestDatabase";
import {
  createSessionAuthFixture,
  loginWithGithub,
  type SessionAuthFixture,
} from "@/test/fixtures/sessionAuth";
import type { AppEnv, Bindings } from "@/types/app";

interface SignedInBrowser {
  cookie: string;
  headers: Headers;
}

interface StoredSession {
  id: string;
  token: string;
  expiresAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.parse("2026-09-05T00:00:00.000Z");

describe.each(["http://localhost:8787", "https://api.opendfieldmap.org"])(
  "persistent browser sessions at %s",
  (baseURL) => {
    let database: TestDatabase;
    let fixture: SessionAuthFixture;
    let env: Bindings;
    let auth: ReturnType<typeof createAuth>;
    let app: Hono<AppEnv<{ requestId: string }>>;

    beforeEach(async () => {
      // JS Date controls auth expiry. SQLite CURRENT_TIMESTAMP keeps wall-clock
      // time; users.last_active is deliberately outside these session assertions.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START_MS);
      fixture = createSessionAuthFixture(baseURL);
      ({ database, env, app } = fixture);
      auth = createAuth(env);
      await auth.$context;
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
      database.close();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    async function signIn(): Promise<SignedInBrowser> {
      const { cookie } = await loginWithGithub(
        fixture,
        baseURL.startsWith("https:") ? "https://opendfieldmap.org" : "http://localhost:5173",
        baseURL,
      );
      return { cookie, headers: new Headers({ cookie: cookie.split(";")[0]! }) };
    }

    function sessionRecord(): StoredSession {
      const row = database.sqlite.prepare("SELECT id, token, expiresAt FROM auth_sessions").get()!;
      return {
        id: String(row.id),
        token: String(row.token),
        expiresAt: new Date(String(row.expiresAt)),
      };
    }

    it("rejects missing session credentials before constructing auth", async () => {
      const constructAuth = vi.spyOn(authModule, "createAuth");
      database.queries.length = 0;
      for (const headers of [new Headers(), new Headers({ cookie: "analytics=abc" })]) {
        const response = await app.request("/auth/v1/session", { headers }, env);
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toMatchObject({ code: "SESSION_REQUIRED" });
      }
      expect(constructAuth).not.toHaveBeenCalled();
      expect(database.queries).toEqual([]);
    });

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

    it("honors the configured TTL and keeps renewal possible for short overrides", async () => {
      const configured = createAuth({ ...env, SESSION_TTL_SECONDS: "3600" });
      expect(configured.options.session).toMatchObject({ expiresIn: 3600, updateAge: 1800 });
      const invalid = createAuth({ ...env, SESSION_TTL_SECONDS: "invalid" });
      expect(invalid.options.session?.expiresIn).toBe(15_552_000);
      await Promise.all([configured.$context, invalid.$context]);
    });

    it("renews both database and browser on repeated 40-day returns, beyond the original expiry", async () => {
      let { headers } = await signIn();
      for (const visitDay of [40, 80, 120, 160, 200, 240, 280, 320, 360, 400]) {
        vi.setSystemTime(START_MS + visitDay * DAY_MS);
        const previousExpiry = sessionRecord().expiresAt;
        await runWithAuthRequest(() => resolveAuthIdentity(env, headers));
        expect(sessionRecord().expiresAt).toEqual(previousExpiry);

        const response = await app.request("/auth/v1/session", { headers }, env);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const renewedCookie = response.headers
          .getSetCookie()
          .find((value) => value.startsWith(`${getCookies(auth.options).sessionToken.name}=`))!;
        expect(renewedCookie).toContain("Max-Age=15552000");
        if (baseURL.startsWith("https:")) {
          expect(renewedCookie).toContain("Partitioned");
        }
        expect(sessionRecord().expiresAt).toEqual(new Date(START_MS + (visitDay + 180) * DAY_MS));
        headers = new Headers({ cookie: renewedCookie.split(";")[0]! });
      }
    });

    it("does not renew repeatedly within a day", async () => {
      const { headers } = await signIn();
      vi.setSystemTime(START_MS + DAY_MS);
      const first = await app.request("/auth/v1/session", { headers }, env);
      expect(first.headers.getSetCookie().length).toBeGreaterThan(0);
      const expiry = sessionRecord().expiresAt;
      vi.setSystemTime(START_MS + DAY_MS + 15 * 60 * 1000);
      const second = await app.request("/auth/v1/session", { headers }, env);
      expect(second.status).toBe(200);
      expect(second.headers.getSetCookie()).toEqual([]);
      expect(sessionRecord().expiresAt).toEqual(expiry);
    });

    it.each(["bearer", "query"])(
      "preserves %s token authentication on the session endpoint",
      async (transport) => {
        await signIn();
        const token = String(sessionRecord().token);
        vi.setSystemTime(START_MS + 40 * DAY_MS);
        const path =
          transport === "query"
            ? `/auth/v1/session?access_token=${encodeURIComponent(token)}`
            : "/auth/v1/session";
        const headers = transport === "bearer" ? { authorization: `Bearer ${token}` } : undefined;
        const response = await app.request(path, { headers }, env);
        expect(response.status).toBe(200);
        expect(sessionRecord().expiresAt).toEqual(new Date(START_MS + 220 * DAY_MS));
      },
    );

    it("upgrades a still-valid seven-day session on its next visit", async () => {
      const { headers } = await signIn();
      database.sqlite
        .prepare("UPDATE auth_sessions SET expiresAt = ?")
        .run(new Date(START_MS + 7 * DAY_MS).toISOString());
      const response = await app.request("/auth/v1/session", { headers }, env);
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=15552000");
      expect(sessionRecord().expiresAt).toEqual(new Date(START_MS + 180 * DAY_MS));
    });

    it("silently migrates a valid legacy cookie without revoking it before browser confirmation", async () => {
      if (!baseURL.startsWith("https:")) {
        return;
      }
      const { cookie } = await signIn();
      const legacyCookie = cookie
        .split(";")[0]!
        .replace("__Secure-oem-chips.", "__Secure-better-auth.");
      const sessionId = sessionRecord().id;
      const migrated = await app.request(
        "/auth/v1/session",
        { headers: { cookie: legacyCookie } },
        env,
      );
      expect(migrated.status).toBe(200);
      expect(await migrated.json()).toMatchObject({ requiresCookieConfirmation: true });
      const migratedCookie = migrated.headers
        .getSetCookie()
        .find((value) => value.startsWith("__Secure-oem-chips.session_token="))!;
      expect(migratedCookie).toContain("Partitioned");
      expect(migratedCookie).toContain("Max-Age=15552000");
      expect(
        migrated.headers
          .getSetCookie()
          .some((value) => value.startsWith("__Secure-better-auth.session_token=")),
      ).toBe(false);
      expect(sessionRecord().id).toBe(sessionId);
      const response = await app.request(
        "/auth/v1/session",
        {
          headers: { cookie: `${legacyCookie}; ${migratedCookie.split(";")[0]}` },
        },
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty("requiresCookieConfirmation");
      const retiredCookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith("__Secure-better-auth.session_token="))!;
      expect(retiredCookie).toContain("Max-Age=0");
      expect(retiredCookie).not.toContain("Partitioned");
      expect(sessionRecord().id).toBe(sessionId);
    });

    it.each(["; ", ";"])(
      "never falls back to an old account when a new cookie is invalid (separator %j)",
      async (separator) => {
        if (!baseURL.startsWith("https:")) {
          return;
        }
        const { cookie } = await signIn();
        const legacyCookie = cookie
          .split(";")[0]!
          .replace("__Secure-oem-chips.", "__Secure-better-auth.");
        const response = await app.request(
          "/auth/v1/session",
          {
            headers: {
              cookie: `${legacyCookie}${separator}__Secure-oem-chips.session_token=invalid`,
            },
          },
          env,
        );
        expect(response.status).toBe(401);
        expect(response.headers.get("set-cookie") ?? "").not.toContain("Max-Age=15552000");
      },
    );

    it("does not migrate a forged legacy signature", async () => {
      if (!baseURL.startsWith("https:")) {
        return;
      }
      await signIn();
      const response = await app.request(
        "/auth/v1/session",
        {
          headers: {
            cookie: `__Secure-better-auth.session_token=${String(sessionRecord().token)}.forged`,
          },
        },
        env,
      );
      expect(response.status).toBe(401);
    });

    it("does not revive an expired session", async () => {
      const { headers } = await signIn();
      vi.setSystemTime(START_MS + 181 * DAY_MS);
      const response = await app.request("/auth/v1/session", { headers }, env);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("set-cookie") ?? "").not.toContain("Max-Age=15552000");
    });

    it("rejects a revoked session even while the middleware user cache is warm", async () => {
      const { headers } = await signIn();
      expect((await app.request("/auth/v1/session", { headers }, env)).status).toBe(200);
      // Revoke independently of logout so its explicit cache invalidation cannot
      // hide a regression in the session endpoint's fresh authentication check.
      database.sqlite.prepare("DELETE FROM auth_sessions WHERE id = ?").run(sessionRecord().id);
      const response = await app.request("/auth/v1/session", { headers }, env);
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie") ?? "").not.toContain("Max-Age=15552000");
    });

    it("retains token-specific expiry errors and private cache headers", async () => {
      const response = await app.request(
        "/auth/v1/session",
        { headers: { authorization: "Bearer missing-token" } },
        env,
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "TOKEN_EXPIRED" });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    });
  },
);
