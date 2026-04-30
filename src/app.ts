import { Hono } from "hono";
import { cors } from "hono/cors";
import { onAppError } from "./middleware/error-handler";
import { requestIdMiddleware } from "./middleware/request-id";
import { createAuthRoutes } from "./routes/auth";
import { createBindingRoutes, createLocatorRoutes } from "./routes/binding";
import { createHealthRoutes } from "./routes/health";
import { createModerationRoutes } from "./routes/moderation";
import { createProgressRoutes } from "./routes/progress";
import { createUploadRoutes } from "./routes/uploads";
import type { AppEnv } from "./types/app";

const DEFAULT_CORS_ORIGINS = [
  "https://opendfieldmap.org",
  "https://www.opendfieldmap.org",
  "https://opendfieldmap.cn",
  "https://www.opendfieldmap.cn"
];

const LOCAL_CORS_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];

function isLocalBackendUrl(raw: string | undefined): boolean {
  if (!raw || raw.trim().length === 0) {
    return false;
  }

  try {
    const url = new URL(raw.trim());
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function parseAllowedOrigins(raw: string | undefined, backendUrl: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return isLocalBackendUrl(backendUrl) ? LOCAL_CORS_ORIGINS : DEFAULT_CORS_ORIGINS;
  }

  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return parsed.length > 0 ? parsed : DEFAULT_CORS_ORIGINS;
}

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("*", requestIdMiddleware);
  app.use(
    "*",
    cors({
      origin: (origin, c) => {
        const allowedOrigins = parseAllowedOrigins(c.env.CORS_ORIGINS, c.env.BETTER_AUTH_URL);
        if (!origin) {
          return allowedOrigins[0] ?? DEFAULT_CORS_ORIGINS[0]!;
        }
        return allowedOrigins.includes(origin)
          ? origin
          : (allowedOrigins[0] ?? DEFAULT_CORS_ORIGINS[0]!);
      },
      allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "x-request-id", "x-oem-locale"],
      credentials: true,
      maxAge: 86400
    })
  );

  app.onError(onAppError);

  app.route("/health/v1", createHealthRoutes());
  app.route("/auth/v1", createAuthRoutes());
  app.route("/binding/v1", createBindingRoutes());
  app.route("/locator", createLocatorRoutes());
  app.route("/progress/v1", createProgressRoutes());
  app.route("/uploads/v1", createUploadRoutes());
  app.route("/moderation/v1", createModerationRoutes());

  app.get("/", (c) => c.json({ status: "ok", message: "Bayes backend is running." }));

  return app;
}
