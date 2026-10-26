import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

import { createAuth, hasSessionCredentials } from "@/lib/auth/betterAuth";
import {
  getLegacyCookieExpirations,
  resolveBrowserSessionHeaders,
  serializeBrowserSessionCookie,
} from "@/lib/auth/browserSession";
import { invalidateAuthUserCache, resolveAuthUser } from "@/lib/auth/identity";
import { getRequestAuthHeaders } from "@/lib/auth/requestHeaders";
import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import type { AppEnv, AuthUser } from "@/types/app";

import { toSessionUser } from "./sessionUser";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>().get(
    "/session",
    createMiddleware<AppEnv<{ authUser: AuthUser; authSessionMigrating: boolean }>>(
      async (c, next) => {
        const authHeaders = getRequestAuthHeaders(c.req.raw);
        if (!hasSessionCredentials(c.env, authHeaders)) {
          throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
        }
        const auth = createAuth(c.env);
        const browserSession = resolveBrowserSessionHeaders(auth, authHeaders);
        const { response: session, headers } = await auth.api.getSession({
          headers: browserSession.headers,
          returnHeaders: true,
        });
        for (const cookie of headers.getSetCookie()) {
          c.header("Set-Cookie", cookie, { append: true });
        }
        if (!session) {
          invalidateAuthUserCache(authHeaders, c.env);
          if (authHeaders.get("authorization")?.trim().toLowerCase().startsWith("bearer ")) {
            throw new ApiError(401, "TOKEN_EXPIRED", "Token is expired, missing, or invalid.");
          }
          throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
        }

        // This fresh, renewing session check also authenticates the middleware.
        // A cached identity with disableRefresh must never replace it.
        c.set(
          "authUser",
          await resolveAuthUser(c.env, authHeaders, {
            uid: session.user.id,
            email: session.user.email,
            displayName: session.user.name,
          }),
        );

        if (browserSession.migrating) {
          c.header("Set-Cookie", await serializeBrowserSessionCookie(auth, session.session), {
            append: true,
          });
        } else if (c.req.header("cookie")?.includes("better-auth.")) {
          for (const cookie of getLegacyCookieExpirations(auth)) {
            c.header("Set-Cookie", cookie, { append: true });
          }
        }
        c.set("authSessionMigrating", browserSession.migrating);
        await next();
      },
    ),
    rateLimit("auth"),
    (c) => {
      const user = c.get("authUser");
      const response = c.json({
        user: toSessionUser(user),
        ...(c.get("authSessionMigrating") ? { requiresCookieConfirmation: true } : {}),
      });
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    },
  );
}
