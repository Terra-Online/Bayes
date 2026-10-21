import { Hono } from "hono";

import { getLegacyCookieExpirations } from "@/lib/auth/browserSession";
import { createAuth } from "@/lib/auth/createAuth";
import { ApiError } from "@/lib/errors";
import { invalidateAuthUserCache } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import type { AppEnv } from "@/types/app";

import { registerAccountAuthRoutes } from "./accountRoutes";
import { registerEmailAuthRoutes } from "./emailRoutes";
import { forwardToAuthJsonPath, forwardToAuthRawRequest } from "./forwarding";
import { registerPasswordResetRoutes } from "./passwordResetRoutes";
import { handleSessionExchange } from "./sessionExchange";
import { registerSessionAuthRoutes } from "./sessionRoutes";
import { registerSocialAuthRoutes } from "./socialRoutes";

export function createAuthRoutes() {
  const app = new Hono<AppEnv>();

  registerEmailAuthRoutes(app, {
    forwardToAuthJsonPath,
    forwardToAuthRawRequest,
  });
  registerPasswordResetRoutes(app, {
    forwardToAuthJsonPath,
  });

  registerSocialAuthRoutes(app, {
    forwardToAuthJsonPath,
    forwardToAuthRawRequest,
  });

  app.post(
    "/session/exchange",
    async (c, next) => {
      await next();
      c.header("Cache-Control", "private, no-store");
    },
    rateLimit("public"),
    handleSessionExchange,
  );

  app.post("/sign-out", rateLimit("public"), async (c) => {
    const response = await forwardToAuthRawRequest(c);
    if (response.ok) {
      invalidateAuthUserCache(c.req.raw.headers, c.env);
      for (const cookie of getLegacyCookieExpirations(createAuth(c.env))) {
        response.headers.append("Set-Cookie", cookie);
      }
    }
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  });

  registerSessionAuthRoutes(app);
  registerAccountAuthRoutes(app, { forwardToAuthJsonPath });

  app.on(["GET", "POST", "OPTIONS"], "/*", async () => {
    throw new ApiError(404, "NOT_FOUND", "Not found.");
  });

  return app;
}
