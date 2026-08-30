import { Hono } from "hono";
import { ApiError } from "../../lib/errors";
import { rateLimit } from "../../middleware/rate-limit";
import type { AppEnv } from "../../types/app";
import { forwardToAuthJsonPath, forwardToAuthRawRequest } from "./forwarding";
import { registerEmailAuthRoutes } from "./emailRoutes";
import { registerPasswordResetRoutes } from "./passwordResetRoutes";
import { registerSocialAuthRoutes } from "./socialRoutes";
import { handleSessionExchange } from "./sessionExchange";
import { registerSessionAuthRoutes } from "./sessionRoutes";
import { registerAccountAuthRoutes } from "./accountRoutes";

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

  app.post("/session/exchange", rateLimit("public"), handleSessionExchange);

  app.post("/sign-out", rateLimit("public"), async (c) => {
    return forwardToAuthRawRequest(c);
  });

  registerSessionAuthRoutes(app);
  registerAccountAuthRoutes(app, { forwardToAuthJsonPath });

  app.on(["GET", "POST", "OPTIONS"], "/*", async () => {
    throw new ApiError(404, "NOT_FOUND", "Not found.");
  });

  return app;
}
