import type { MiddlewareHandler } from "hono";
import { ApiError } from "../lib/errors";
import { getUploadRateLimitForKarma } from "../lib/karma/rules";
import { createRedisClient } from "../lib/redis";
import type { AppEnv } from "../types/app";

const OTP_SEND_IP_LIMIT_PER_MINUTE = 20;
const OTP_SEND_EMAIL_LIMIT_PER_HOUR = 8;
const AUTH_LIMIT_PER_MINUTE = 120;
const BINDING_LIMIT_PER_MINUTE = 80;
const PUBLIC_LIMIT_PER_MINUTE = 80;
const RESET_SEND_LIMIT_PER_MINUTE = 80;
const EMAIL_COOLDOWN_SECONDS = 100;
const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const LOCAL_READ_RATE_CACHE_MAX_ENTRIES = 5000;

type RateLimitScope = "public" | "auth" | "binding" | "otp-send" | "reset-send" | "upload";

interface SlidingWindowResult {
  count: number;
  remaining: number;
  resetAt: number;
  exceeded: boolean;
}

type LocalWindowEntry = {
  count: number;
  resetAt: number;
};

function buildRateLimitDetails(result: SlidingWindowResult, limit: number): Record<string, number> {
  const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  return {
    limit,
    remaining: result.remaining,
    resetAt: Math.floor(result.resetAt / 1000),
    retryAfterSeconds
  };
}

const localReadWindows = new Map<string, LocalWindowEntry>();

function getWindowMs(scope: RateLimitScope): number {
  if (scope === "otp-send") {
    return ONE_MINUTE_MS;
  }
  return ONE_MINUTE_MS;
}

function getScopeLimit(scope: RateLimitScope): number {
  if (scope === "upload") {
    return AUTH_LIMIT_PER_MINUTE;
  }

  if (scope === "auth") {
    return AUTH_LIMIT_PER_MINUTE;
  }

  if (scope === "binding") {
    return BINDING_LIMIT_PER_MINUTE;
  }

  if (scope === "otp-send") {
    return OTP_SEND_IP_LIMIT_PER_MINUTE;
  }

  if (scope === "reset-send") {
    return RESET_SEND_LIMIT_PER_MINUTE;
  }

  return PUBLIC_LIMIT_PER_MINUTE;
}

function getLimitForRequest(scope: RateLimitScope, c: Parameters<MiddlewareHandler<AppEnv>>[0]): number {
  if (scope === "upload") {
    const user = c.get("authUser");
    return getUploadRateLimitForKarma(user?.karma ?? 0);
  }

  return getScopeLimit(scope);
}

function pruneLocalReadWindows(now: number): void {
  if (localReadWindows.size <= LOCAL_READ_RATE_CACHE_MAX_ENTRIES) {
    return;
  }

  for (const [key, entry] of localReadWindows) {
    if (entry.resetAt <= now || localReadWindows.size > LOCAL_READ_RATE_CACHE_MAX_ENTRIES) {
      localReadWindows.delete(key);
    }
    if (localReadWindows.size <= LOCAL_READ_RATE_CACHE_MAX_ENTRIES) {
      return;
    }
  }
}

function applyLocalFixedWindowLimit(
  identity: string,
  limit: number,
  windowMs: number
): SlidingWindowResult {
  const now = Date.now();
  const entry = localReadWindows.get(identity);
  const active = entry && entry.resetAt > now
    ? entry
    : {
      count: 0,
      resetAt: now + windowMs,
    };

  if (active.count >= limit) {
    return {
      count: active.count,
      remaining: 0,
      resetAt: active.resetAt,
      exceeded: true,
    };
  }

  active.count += 1;
  pruneLocalReadWindows(now);
  localReadWindows.set(identity, active);

  return {
    count: active.count,
    remaining: Math.max(0, limit - active.count),
    resetAt: active.resetAt,
    exceeded: false,
  };
}

function canUseLocalReadLimit(
  scope: RateLimitScope,
  c: Parameters<MiddlewareHandler<AppEnv>>[0]
): boolean {
  const method = c.req.method.toUpperCase();
  const readMethod = method === "GET" || method === "HEAD" || method === "OPTIONS";
  return readMethod && (scope === "public" || scope === "auth");
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
  return c.req.header("cf-connecting-ip") ?? "anonymous";
}

async function applySlidingWindowLimit(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  redisKey: string,
  limit: number,
  windowMs: number
): Promise<SlidingWindowResult> {
  const redis = createRedisClient(c.env);
  const now = Date.now();
  const windowStart = now - windowMs;

  await redis.zremrangebyscore(redisKey, 0, windowStart);

  const currentRaw = await redis.zcard(redisKey);
  const current = Number(currentRaw ?? 0);
  const resetAt = now + windowMs;

  if (current >= limit) {
    return {
      count: current,
      remaining: 0,
      resetAt,
      exceeded: true,
    };
  }

  await redis.zadd(redisKey, {
    score: now,
    member: `${now}:${crypto.randomUUID()}`,
  });

  await redis.expire(redisKey, Math.ceil((windowMs + 5000) / 1000));

  const nextCount = current + 1;
  return {
    count: nextCount,
    remaining: Math.max(0, limit - nextCount),
    resetAt,
    exceeded: false,
  };
}

export function rateLimit(scope: RateLimitScope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestIp = getRequestIp(c);
    const user = c.get("authUser");
    if (user?.role === "r") {
      await next();
      return;
    }
    const identity = scope === "upload" && user ? `user:${user.uid}` : `ip:${requestIp}`;
    const limit = getLimitForRequest(scope, c);
    const windowMs = getWindowMs(scope);

    try {
      if (canUseLocalReadLimit(scope, c)) {
        const result = applyLocalFixedWindowLimit(`${scope}:${identity}`, limit, windowMs);
        c.header("x-ratelimit-limit", String(limit));
        c.header("x-ratelimit-remaining", String(result.remaining));
        c.header("x-ratelimit-reset", String(Math.floor(result.resetAt / 1000)));
        c.header("x-ratelimit-backend", "local");

        if (result.exceeded) {
          c.header("retry-after", String(buildRateLimitDetails(result, limit).retryAfterSeconds));
          throw new ApiError(429, "RATE_LIMITED", "Too many requests.", buildRateLimitDetails(result, limit));
        }

        await next();
        return;
      }

      const redis = createRedisClient(c.env);
      const redisKey = `rate:${scope}:${identity}`;
      const result = await applySlidingWindowLimit(c, redisKey, limit, windowMs);

      c.header("x-ratelimit-limit", String(limit));
      c.header("x-ratelimit-remaining", String(result.remaining));
      c.header("x-ratelimit-reset", String(Math.floor(result.resetAt / 1000)));

      if (result.exceeded) {
        c.header("retry-after", String(buildRateLimitDetails(result, limit).retryAfterSeconds));
        throw new ApiError(429, "RATE_LIMITED", "Too many requests.", buildRateLimitDetails(result, limit));
      }

      if (scope === "otp-send") {
        const email = await tryExtractEmailFromJson(c);
        if (email) {
          const cooldownKey = `rate:${scope}:email-cooldown:${email}`;
          const cooldownPlaced = await redis.set(cooldownKey, String(Date.now()), {
            nx: true,
            ex: EMAIL_COOLDOWN_SECONDS,
          });

          if (!cooldownPlaced) {
            const retryAfterRaw = await redis.ttl(cooldownKey);
            const retryAfter = Number(retryAfterRaw ?? EMAIL_COOLDOWN_SECONDS);
            if (Number.isFinite(retryAfter) && retryAfter > 0) {
              c.header("retry-after", String(Math.ceil(retryAfter)));
            }
            throw new ApiError(
              429,
              "RATE_LIMITED",
              "Please wait before requesting another email.",
              {
                retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0
                  ? Math.ceil(retryAfter)
                  : EMAIL_COOLDOWN_SECONDS,
              }
            );
          }

          const emailKey = `rate:otp-send:email:${email}`;
          const emailResult = await applySlidingWindowLimit(
            c,
            emailKey,
            OTP_SEND_EMAIL_LIMIT_PER_HOUR,
            ONE_HOUR_MS
          );

          if (emailResult.exceeded) {
            throw new ApiError(429, "RATE_LIMITED", "Too many OTP requests.");
          }
        }
      }

      if (scope === "reset-send") {
        const email = await tryExtractEmailFromJson(c);
        if (email) {
          const cooldownKey = `rate:${scope}:email-cooldown:${email}`;
          const cooldownPlaced = await redis.set(cooldownKey, String(Date.now()), {
            nx: true,
            ex: EMAIL_COOLDOWN_SECONDS,
          });

          if (!cooldownPlaced) {
            const retryAfterRaw = await redis.ttl(cooldownKey);
            const retryAfter = Number(retryAfterRaw ?? EMAIL_COOLDOWN_SECONDS);
            if (Number.isFinite(retryAfter) && retryAfter > 0) {
              c.header("retry-after", String(Math.ceil(retryAfter)));
            }
            throw new ApiError(
              429,
              "RATE_LIMITED",
              "Please wait before requesting another email.",
              {
                retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0
                  ? Math.ceil(retryAfter)
                  : EMAIL_COOLDOWN_SECONDS,
              }
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      console.error("[rate-limit] backend failure", {
        scope,
        requestIp,
        error,
      });
      throw new ApiError(503, "RATE_LIMIT_BACKEND_UNAVAILABLE", "Rate limit service unavailable.");
    }

    await next();
  };
}
