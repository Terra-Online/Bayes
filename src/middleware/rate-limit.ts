import type { MiddlewareHandler } from "hono";
import { ApiError } from "../lib/errors";
import { createRedisClient } from "../lib/redis";
import type { AppEnv, Role } from "../types/app";

const ROLE_LIMITS: Record<Role, number> = {
  normal: 120,
  moderator: 300,
  admin: 600
};

function getWindowKey(scope: string, key: string): { redisKey: string; resetAt: number } {
  const now = Date.now();
  const minuteStart = Math.floor(now / 60000);
  const resetAt = (minuteStart + 1) * 60000;
  return {
    redisKey: `rate:${scope}:${minuteStart}:${key}`,
    resetAt
  };
}

export function rateLimit(scope: "public" | "auth"): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const redis = createRedisClient(c.env);
    const user = c.get("authUser");

    const identity =
      user?.uid ?? c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "anonymous";

    const limit = scope === "public" ? 80 : user ? ROLE_LIMITS[user.role] : 60;
    const windowData = getWindowKey(scope, identity);

    const current = await redis.incr(windowData.redisKey);
    if (current === 1) {
      await redis.expire(windowData.redisKey, 65);
    }

    c.header("x-ratelimit-limit", String(limit));
    c.header("x-ratelimit-remaining", String(Math.max(0, limit - current)));
    c.header("x-ratelimit-reset", String(Math.floor(windowData.resetAt / 1000)));

    if (current > limit) {
      throw new ApiError(429, "RATE_LIMITED", "Too many requests.");
    }

    await next();
  };
}
