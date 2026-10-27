import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import { parseInput, readJsonBody } from "@/routes/input";
import { toUserResponse } from "@/routes/response/userResponse";
import { sessionExchangeSchema } from "@/routes/schema/auth";
import { getRequestAuthCredentials } from "@/services/auth/requestCredentials";
import { parseTrustedFrontendOrigins } from "@/services/auth/rules/frontendOrigins";
import { readSession } from "@/services/auth/session";
import { exchangeSession } from "@/services/auth/sessionExchange";
import { signOut } from "@/services/auth/signOut";
import type { AppEnv, AuthUser } from "@/types/app";

import { authRequestInfo, authResponse } from "./honoAdapter";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .get(
      "/session",
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
        });
        response.headers.set("Cache-Control", "private, no-store");
        return response;
      },
    )
    .post("/session/exchange", rateLimit("public"), async (c) => {
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
      return c.json({ user: toUserResponse(result.user) });
    })
    .post("/sign-out", rateLimit("public"), async (c) => {
      const body = c.req.raw.body === null ? null : await c.req.arrayBuffer();
      return authResponse(
        c,
        await signOut(c.env, {
          body,
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
        }),
      );
    });
}
