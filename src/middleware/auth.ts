import type { Context, MiddlewareHandler } from "hono";
import { createAuth } from "../lib/auth/createAuth";
import { ApiError } from "../lib/errors";
import { ensureUserProfile, formatPublicUid } from "../repositories/users";
import type { AppEnv, AuthUser, Role } from "../types/app";

const AUTH_USER_CACHE_TTL_MS = 10_000;
const AUTH_USER_CACHE_MAX_ENTRIES = 1000;

type CachedAuthUser = {
  user: AuthUser;
  expiresAt: number;
};

export type AuthIdentity = {
  uid: string;
  email: string;
  displayName?: string;
};

type CachedAuthIdentity = {
  identity: AuthIdentity;
  expiresAt: number;
};

const authUserCache = new Map<string, CachedAuthUser>();
const authIdentityCache = new Map<string, CachedAuthIdentity>();
const authUserRequests = new Map<string, Promise<AuthUser>>();
const authIdentityRequests = new Map<string, Promise<AuthIdentity>>();

function buildAuthHeaders(headers: Headers, accessToken?: string | null): Headers {
  if (!accessToken?.trim() || headers.has("authorization")) {
    return headers;
  }

  const nextHeaders = new Headers(headers);
  nextHeaders.set("authorization", `Bearer ${accessToken.trim()}`);
  return nextHeaders;
}

function getAuthCacheKey(headers: Headers): string | null {
  const authorization = headers.get("authorization")?.trim();
  if (authorization) return `authorization:${authorization}`;

  const cookie = headers.get("cookie")?.trim();
  return cookie ? `cookie:${cookie}` : null;
}

export function invalidateAuthUserCache(headers: Headers): void {
  const cacheKey = getAuthCacheKey(headers);
  if (cacheKey) {
    authUserCache.delete(cacheKey);
  }
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

function pruneAuthIdentityCache(now: number): void {
  if (authIdentityCache.size <= AUTH_USER_CACHE_MAX_ENTRIES) return;

  for (const [key, value] of authIdentityCache) {
    if (value.expiresAt <= now || authIdentityCache.size > AUTH_USER_CACHE_MAX_ENTRIES) {
      authIdentityCache.delete(key);
    }
    if (authIdentityCache.size <= AUTH_USER_CACHE_MAX_ENTRIES) return;
  }
}

function identityFromAuthUser(user: AuthUser): AuthIdentity {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.nickname
  };
}

async function fetchAuthIdentity(
  env: AppEnv["Bindings"],
  headers: Headers,
  cacheKey: string | null,
  now: number
): Promise<AuthIdentity> {
  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers });
  if (!session) {
    const authorization = headers.get("authorization")?.trim() ?? "";
    const hasBearerToken = authorization.toLowerCase().startsWith("bearer ");
    if (hasBearerToken) {
      throw new ApiError(401, "TOKEN_EXPIRED", "Token is expired, missing, or invalid.");
    }
    throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
  }

  const identity = {
    uid: session.user.id,
    email: session.user.email,
    displayName: session.user.name
  };
  if (cacheKey) {
    pruneAuthIdentityCache(now);
    authIdentityCache.set(cacheKey, {
      identity,
      expiresAt: now + AUTH_USER_CACHE_TTL_MS
    });
  }
  return identity;
}

export async function resolveAuthIdentity(env: AppEnv["Bindings"], headers: Headers): Promise<AuthIdentity> {
  const now = Date.now();
  const cacheKey = getAuthCacheKey(headers);
  const cachedUser = cacheKey ? authUserCache.get(cacheKey) : undefined;
  if (cachedUser && cachedUser.expiresAt > now) {
    return identityFromAuthUser(cachedUser.user);
  }
  const cachedIdentity = cacheKey ? authIdentityCache.get(cacheKey) : undefined;
  if (cachedIdentity && cachedIdentity.expiresAt > now) {
    return cachedIdentity.identity;
  }
  if (!cacheKey) {
    return fetchAuthIdentity(env, headers, null, now);
  }

  const pending = authIdentityRequests.get(cacheKey);
  if (pending) return pending;

  const request = fetchAuthIdentity(env, headers, cacheKey, now);
  authIdentityRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (authIdentityRequests.get(cacheKey) === request) {
      authIdentityRequests.delete(cacheKey);
    }
  }
}

async function fetchAuthUser(
  env: AppEnv["Bindings"],
  headers: Headers,
  cacheKey: string | null,
  now: number
): Promise<AuthUser> {
  const identity = await resolveAuthIdentity(env, headers);

  const profile = await ensureUserProfile(env.DB, {
    uid: identity.uid,
    email: identity.email,
    displayName: identity.displayName
  });

  const authUser: AuthUser = {
    uid: profile.uid,
    publicUid: formatPublicUid(profile.uidNumber, profile.uidSuffix),
    role: profile.role,
    karma: profile.karma,
    avatar: profile.avt,
    email: profile.email,
    nickname: profile.nickname,
    registeredAt: profile.createdAt,
    needsProfileSetup: !profile.nicknameCustomized
  };

  if (cacheKey) {
    pruneAuthUserCache(now);
    authUserCache.set(cacheKey, {
      user: authUser,
      expiresAt: now + AUTH_USER_CACHE_TTL_MS
    });
  }

  return authUser;
}

export async function resolveAuthUser(env: AppEnv["Bindings"], headers: Headers): Promise<AuthUser> {
  const now = Date.now();
  const cacheKey = getAuthCacheKey(headers);
  const cached = cacheKey ? authUserCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > now) {
    return cached.user;
  }
  if (!cacheKey) {
    return fetchAuthUser(env, headers, null, now);
  }

  const pending = authUserRequests.get(cacheKey);
  if (pending) return pending;

  const request = fetchAuthUser(env, headers, cacheKey, now);
  authUserRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (authUserRequests.get(cacheKey) === request) {
      authUserRequests.delete(cacheKey);
    }
  }
}

export async function resolveRequestAuthUser(
  env: AppEnv["Bindings"],
  request: Request
): Promise<AuthUser> {
  const url = new URL(request.url);
  const headers = buildAuthHeaders(request.headers, url.searchParams.get("access_token"));
  return resolveAuthUser(env, headers);
}

export async function resolveContextAuthUser(c: Context<AppEnv>): Promise<AuthUser> {
  const existing = c.get("authUser");
  if (existing) return existing;

  const authUser = await resolveRequestAuthUser(c.env, c.req.raw);
  c.set("authUser", authUser);
  return authUser;
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  await resolveContextAuthUser(c);
  await next();
};

export function requireRole(roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("authUser");
    const effectiveRole = user?.role === "r" ? "a" : user?.role;
    if (!user || !effectiveRole || !roles.includes(effectiveRole)) {
      throw new ApiError(403, "ACCESS_DENIED", "Insufficient permissions.");
    }
    await next();
  };
}
