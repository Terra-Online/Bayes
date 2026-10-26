import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { expect, vi, type Mock } from "vitest";

import { runWithAuthRequest } from "@/lib/auth/betterAuth";
import { onAppError } from "@/middleware/error-handler";
import { createRoutes as createAuthRoutes } from "@/routes/auth/createRoutes";
import { createRoutes as createSessionExchangeRoutes } from "@/routes/auth/sessionExchangeRoutes";
import { createRoutes as createSessionRoutes } from "@/routes/auth/sessionRoutes";
import { createRoutes as createSignOutRoutes } from "@/routes/auth/signOutRoutes";
import { createRoutes as createSocialRoutes } from "@/routes/auth/socialRoutes";
import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { stubRequestWithDuplex } from "@/test/fixtures/request";
import type { AppEnv, Bindings } from "@/types/app";

export interface SessionAuthFixture {
  database: TestDatabase;
  env: Bindings;
  app: Hono<AppEnv<{ requestId: string }>>;
  oauthFetch: Mock<typeof fetch>;
}

export interface OAuthLogin {
  initiated: Response;
  callback: Response;
  cookie: string;
  token: string;
}

let clientNumber = 0;

/** Production auth routes with the same per-request ownership as the Worker. */
export function createSessionAuthFixture(baseURL: string): SessionAuthFixture {
  const database = createTestDatabase();
  const mocks = createMockBindings({ DB: database.db });
  mocks.publicRateLimit.limit.mockResolvedValue({ success: true });
  mocks.authRateLimit.limit.mockResolvedValue({ success: true });
  const env = { ...mocks.bindings, BETTER_AUTH_URL: baseURL };
  // Better Auth and route read limits have process-local windows keyed by IP.
  const clientIp = `192.0.2.${++clientNumber}`;
  const app = new Hono<AppEnv<{ requestId: string }>>()
    .use(
      "*",
      createMiddleware<AppEnv>((c, next) => {
        c.req.raw.headers.set("cf-connecting-ip", clientIp);
        return runWithAuthRequest(next);
      }),
    )
    .onError(onAppError)
    .route("/auth/v1", createSocialRoutes())
    .route("/auth/v1", createSessionExchangeRoutes())
    .route("/auth/v1", createSessionRoutes())
    .route("/auth/v1", createSignOutRoutes())
    .route("/auth/v1", createAuthRoutes());
  const oauthFetch = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    if (
      request.url === "https://github.com/login/oauth/access_token" &&
      request.method === "POST"
    ) {
      return Response.json({
        access_token: "synthetic-github-access",
        token_type: "bearer",
        scope: "user:email",
      });
    }
    if (request.url === "https://api.github.com/user" && request.method === "GET") {
      return Response.json({
        id: 12345,
        login: "tester",
        name: "Tester",
        email: "session@example.com",
        avatar_url: null,
      });
    }
    if (request.url === "https://api.github.com/user/emails" && request.method === "GET") {
      return Response.json([{ email: "session@example.com", primary: true, verified: true }]);
    }
    throw new Error(`Unconfigured OAuth fetch: ${request.method} ${request.url}`);
  });
  vi.stubGlobal("fetch", oauthFetch);
  stubRequestWithDuplex();
  return { database, env, app, oauthFetch };
}

/** Follow real social authorization state into the production GitHub callback. */
export async function loginWithGithub(
  fixture: SessionAuthFixture,
  origin: string,
  apiOrigin: string,
): Promise<OAuthLogin> {
  const { app, env, database } = fixture;
  const initiated = await app.request(
    `${apiOrigin}/auth/v1/sign-in/social`,
    {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        callbackURL: `${origin}/?test=1`,
        disableRedirect: true,
      }),
    },
    env,
  );
  expect(initiated.status).toBe(200);
  const authorization = new URL(((await initiated.clone().json()) as { url: string }).url);
  const state = authorization.searchParams.get("state")!;
  const stored = database.sqlite.prepare("SELECT value FROM auth_verifications").get()!;
  const callbackState = JSON.parse(String(stored.value)) as {
    callbackURL: string;
    newUserURL: string;
  };
  expect(callbackState.newUserURL).toBe(callbackState.callbackURL);
  const callback = await app.request(
    `${apiOrigin}/auth/v1/callback/github?code=github-code&state=${encodeURIComponent(state)}`,
    {
      headers: {
        cookie: initiated.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; "),
      },
    },
    env,
  );
  expect(callback.status).toBe(302);
  const cookie = callback.headers
    .getSetCookie()
    .find((value) => value.split("=")[0]!.endsWith(".session_token"))!;
  const row = database.sqlite.prepare("SELECT token FROM auth_sessions").get()!;
  return { initiated, callback, cookie, token: String(row.token) };
}
