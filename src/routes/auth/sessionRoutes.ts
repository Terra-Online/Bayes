import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

import { readSession } from "@/lib/auth/session";
import { rateLimit } from "@/middleware/rate-limit";
import type { AppEnv, AuthUser } from "@/types/app";

import { toSessionUser } from "./sessionUser";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>().get(
    "/session",
    createMiddleware<AppEnv<{ authUser: AuthUser; requiresCookieConfirmation: boolean }>>(
      async (c, next) => {
        const result = await readSession(c.env, {
          cookie: c.req.header("cookie"),
          authorization: c.req.header("authorization"),
          accessToken: new URL(c.req.url).searchParams.get("access_token") ?? undefined,
        });
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
        user: toSessionUser(c.get("authUser")),
        ...(c.get("requiresCookieConfirmation") ? { requiresCookieConfirmation: true } : {}),
      });
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    },
  );
}
