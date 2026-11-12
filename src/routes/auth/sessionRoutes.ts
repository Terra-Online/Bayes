import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import { parseInput, readJsonBody } from "@/routes/input";
import { operation, sessionSecurity, optionalSessionSecurity } from "@/routes/openapi/operation";
import { toUserResponse } from "@/routes/response/userResponse";
import * as docs from "@/routes/schema/auth";
import { sessionExchangeSchema } from "@/routes/schema/auth";
import { getRequestAuthCredentials } from "@/services/auth/requestCredentials";
import { parseTrustedFrontendOrigins } from "@/services/auth/rules/frontendOrigins";
import { readSession } from "@/services/auth/session";
import { exchangeSession } from "@/services/auth/sessionExchange";
import { signOut } from "@/services/auth/signOut";
import type { AppEnv, AuthUser } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .get(
      "/session",
      operation("getSession", "Accounts", "Read the session and business user", {
        errors: [429, 503],
        security: sessionSecurity,
        response: docs.sessionResponseSchema,
        description:
          "Returns the business profile for the current session. Browser clients send credentials: include and must complete cookie confirmation when the response requests it.",
      }),
      createMiddleware<AppEnv<{ authUser: AuthUser; requiresCookieConfirmation: boolean }>>(
        async (c, next) => {
          const result = await readSession(c.env, getRequestAuthCredentials(c.req.raw));
          for (const cookie of result.cookies) {
            c.header("Set-Cookie", cookie, { append: true });
          }
          if (!result.ok) {
            throw result.error;
          }
          c.set("authUser", result.user);
          c.set("requiresCookieConfirmation", result.requiresCookieConfirmation);
          await next();
        },
      ),
      rateLimit("auth"),
      (c) => {
        const response = c.json({
          user: toUserResponse(c.get("authUser")),
          ...(c.get("requiresCookieConfirmation") ? { requiresCookieConfirmation: true } : {}),
        } satisfies z.output<typeof docs.sessionResponseSchema>);
        response.headers.set("Cache-Control", "private, no-store");
        return response;
      },
    )
    .post(
      "/session/exchange",
      operation("exchangeSession", "Accounts", "Exchange an OAuth code for a browser session", {
        errors: [401, 403, 429, 503],
        body: docs.sessionExchangeSchema,
        response: docs.sessionResponseSchema,
        description:
          "Requires a trusted Origin and the browser proof established before social login. A code alone is insufficient.",
      }),
      rateLimit("public"),
      async (c) => {
        const origin = c.req.header("origin");
        if (!origin || !parseTrustedFrontendOrigins(c.env).includes(origin)) {
          throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "A trusted frontend origin is required.");
        }
        const input = parseInput(sessionExchangeSchema, await readJsonBody(c.req));
        const result = await exchangeSession(c.env, {
          code: input.code,
          origin,
          cookie: c.req.header("cookie"),
          userAgent: c.req.header("user-agent"),
          requestId: c.get("requestId"),
        });
        for (const cookie of result.cookies) {
          c.header("Set-Cookie", cookie, { append: true });
        }
        c.header("Cache-Control", "private, no-store");
        return c.json({ user: toUserResponse(result.user) } satisfies z.output<
          typeof docs.sessionResponseSchema
        >);
      },
    )
    .post(
      "/sign-out",
      operation("signOut", "Accounts", "Sign out and expire session cookies", {
        errors: [429, 503],
        security: optionalSessionSecurity,
        response: z.object({ success: z.boolean() }),
      }),
      rateLimit("public"),
      async (c) => {
        return signOut(c.env, {
          raw_request: c.req.raw,
          requestId: c.get("requestId"),
        });
      },
    );
}
