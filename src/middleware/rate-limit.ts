import type { MiddlewareHandler } from "hono";
import { ApiError } from "../lib/errors";
import { createRedisClient } from "../lib/redis";
import type { AppEnv, Role } from "../types/app";

const OTP_SEND_IP_LIMIT_PER_MINUTE = 20;
const OTP_SEND_EMAIL_LIMIT_PER_HOUR = 8;

const ROLE_LIMITS: Record<Role, number> = {
  n: 120,
  p: 300,
  a: 600,
  s: 20,
  r: 40
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

function getHourWindowKey(scope: string, key: string): { redisKey: string; resetAt: number } {
  const now = Date.now();
  const hourStart = Math.floor(now / 3600000);
  const resetAt = (hourStart + 1) * 3600000;
  return {
    redisKey: `rate:${scope}:${hourStart}:${key}`,
    resetAt,
  };
}

function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

async function tryExtractEmailFromJson(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Promise<string | null> {
  const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  try {
    const payload = (await c.req.raw.clone().json()) as Record<string, unknown>;
    const email = payload.email;
    if (typeof email !== "string") {
      return null;
    }

    const normalized = normalizeEmail(email);
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

function getRequestIp(c: Parameters<MiddlewareHandler<AppEnv>>[0]): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "anonymous";
}

export function rateLimit(scope: "public" | "auth" | "otp-send"): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const redis = createRedisClient(c.env);
    const user = c.get("authUser");
    const requestIp = getRequestIp(c);

    const identity = scope === "auth" && user ? user.uid : requestIp;

    const limit =
      scope === "public"
        ? 80
        : scope === "auth"
          ? user
            ? ROLE_LIMITS[user.role]
            : 60
          : OTP_SEND_IP_LIMIT_PER_MINUTE;

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

    if (scope === "otp-send") {
      const email = await tryExtractEmailFromJson(c);
      if (email) {
        const emailWindowData = getHourWindowKey("otp-send-email", email);
        const emailCurrent = await redis.incr(emailWindowData.redisKey);
        if (emailCurrent === 1) {
          await redis.expire(emailWindowData.redisKey, 3605);
        }

        c.header("x-ratelimit-email-limit", String(OTP_SEND_EMAIL_LIMIT_PER_HOUR));
        c.header("x-ratelimit-email-remaining", String(Math.max(0, OTP_SEND_EMAIL_LIMIT_PER_HOUR - emailCurrent)));
        c.header("x-ratelimit-email-reset", String(Math.floor(emailWindowData.resetAt / 1000)));

        if (emailCurrent > OTP_SEND_EMAIL_LIMIT_PER_HOUR) {
          throw new ApiError(429, "RATE_LIMITED", "Too many OTP requests for this email.");
        }
      }
    }

    await next();
  };
}
