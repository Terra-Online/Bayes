import { Hono } from "hono";
import { z } from "zod";
import { getRuntimeConfig } from "../lib/config";
import { ApiError } from "../lib/errors";
import { createRedisClient } from "../lib/redis";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { readProgress, syncProgressToCache } from "../services/progress";
import type { AppEnv } from "../types/app";

const syncSchema = z.object({
  version: z.number().int().min(0),
  marker: z.string(),
  pointsDelta: z.number().int().min(-1000).max(1000).optional()
});

export function createProgressRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    const redis = createRedisClient(c.env);
    const config = getRuntimeConfig(c.env);
    const progress = await readProgress(c.env.DB, redis, user.uid, config.progressCacheTtlSeconds);

    return c.json({ progress });
  });

  app.post("/sync", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    const parsed = syncSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid progress payload.", parsed.error.flatten());
    }

    const redis = createRedisClient(c.env);
    const config = getRuntimeConfig(c.env);
    const current = await readProgress(c.env.DB, redis, user.uid, config.progressCacheTtlSeconds);

    if (parsed.data.version <= current.version) {
      throw new ApiError(409, "PROGRESS_VERSION_CONFLICT", "Incoming version is older or equal to current version.", {
        serverVersion: current.version
      });
    }

    await syncProgressToCache(
      redis,
      user.uid,
      {
        version: parsed.data.version,
        marker: parsed.data.marker
      },
      parsed.data.pointsDelta ?? 0,
      config.progressCacheTtlSeconds
    );

    return c.json({
      ok: true,
      progress: {
        version: parsed.data.version,
        marker: parsed.data.marker
      }
    });
  });

  return app;
}
