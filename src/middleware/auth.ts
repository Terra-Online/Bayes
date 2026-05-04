import type { MiddlewareHandler } from "hono";
import { createAuth } from "../lib/auth";
import { ApiError } from "../lib/errors";
import { ensureUserProfile, formatPublicUid } from "../repositories/users";
import type { AppEnv, AuthUser, Role } from "../types/app";

const AUTH_USER_CACHE_TTL_MS = 10_000;
const AUTH_USER_CACHE_MAX_ENTRIES = 1000;

type CachedAuthUser = {
  user: AuthUser;
  expiresAt: number;
};

const authUserCache = new Map<string, CachedAuthUser>();

function getAuthCacheKey(headers: Headers): string | null {
  const authorization = headers.get("authorization")?.trim();
  if (authorization) return `authorization:${authorization}`;

  const cookie = headers.get("cookie")?.trim();
  return cookie ? `cookie:${cookie}` : null;
}

function pruneAuthUserCache(now: number): void {
  if (authUserCache.size <= AUTH_USER_CACHE_MAX_ENTRIES) return;

  for (const [key, value] of authUserCache) {
    if (value.expiresAt <= now || authUserCache.size > AUTH_USER_CACHE_MAX_ENTRIES) {
      authUserCache.delete(key);
    }
    if (authUserCache.size <= AUTH_USER_CACHE_MAX_ENTRIES) return;
  }
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const now = Date.now();
  const cacheKey = getAuthCacheKey(c.req.raw.headers);
  const cached = cacheKey ? authUserCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > now) {
    c.set("authUser", cached.user);
    await next();
    return;
  }

  const auth = createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers
  });

  if (!session) {
    const authorization = c.req.header("authorization")?.trim() ?? "";
    const hasBearerToken = authorization.toLowerCase().startsWith("bearer ");
    if (hasBearerToken) {
      throw new ApiError(401, "TOKEN_EXPIRED", "Token is expired, missing, or invalid.");
    }
    throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
  }

  const profile = await ensureUserProfile(c.env.DB, {
    uid: session.user.id,
    email: session.user.email,
    displayName: session.user.name
  });

  const authUser: AuthUser = {
    uid: profile.uid,
    publicUid: formatPublicUid(profile.uidNumber, profile.uidSuffix),
    role: profile.role,
    karma: profile.karma,
    avatar: profile.avt,
    email: profile.email,
    nickname: profile.nickname,
    needsProfileSetup: !profile.nicknameCustomized
  };

  if (cacheKey) {
    pruneAuthUserCache(now);
    authUserCache.set(cacheKey, {
      user: authUser,
      expiresAt: now + AUTH_USER_CACHE_TTL_MS
    });
  }

  c.set("authUser", authUser);

  await next();
};

export function requireRole(roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("authUser");
    if (!user || !roles.includes(user.role)) {
      throw new ApiError(403, "ACCESS_DENIED", "Insufficient permissions.");
    }
    await next();
  };
}
