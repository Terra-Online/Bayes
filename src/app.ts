import { Hono } from "hono";
import { cors } from "hono/cors";
import { onAppError } from "./middleware/error-handler";
import { requestIdMiddleware } from "./middleware/request-id";
import { createAuthRoutes } from "./routes/auth";
import { createHealthRoutes } from "./routes/health";
import { createModerationRoutes } from "./routes/moderation";
import { createProgressRoutes } from "./routes/progress";
import { createUploadRoutes } from "./routes/uploads";
import type { AppEnv } from "./types/app";

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("*", requestIdMiddleware);
  app.use(
    "*",
    cors({
      origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "x-request-id", "x-oem-locale"],
      credentials: true,
      maxAge: 86400
    })
  );

  app.onError(onAppError);

  app.route("/health/v1", createHealthRoutes());
  app.route("/auth/v1", createAuthRoutes());
  app.route("/progress/v1", createProgressRoutes());
  app.route("/uploads/v1", createUploadRoutes());
  app.route("/moderation/v1", createModerationRoutes());

  app.get("/", (c) => c.json({ status: "ok", message: "Bayes backend is running." }));

  return app;
}
