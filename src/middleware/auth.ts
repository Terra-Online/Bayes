import type { Context, MiddlewareHandler } from "hono";
import { createAuth } from "../lib/auth/createAuth";
import { resolveBrowserSessionHeaders } from "../lib/auth/browserSession";
import { hasSessionCredentials } from "../lib/auth/sessionCredentials";
import { sameAuthEnvironment } from "../lib/auth/environment";
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

type AuthCache = {
  env: AppEnv["Bindings"];
  revision: number;
  users: Map<string, CachedAuthUser>;
  identities: Map<string, CachedAuthIdentity>;
};
const authCaches = new WeakMap<D1Database, AuthCache>();

function getAuthCache(env: AppEnv["Bindings"]): AuthCache {
  let cache = authCaches.get(env.DB);
  if (!cache || !sameAuthEnvironment(cache.env, env)) {
    cache = { env: { ...env }, revision: 0, users: new Map(), identities: new Map() };
    authCaches.set(env.DB, cache);
  }
  return cache;
}

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

export function invalidateAuthUserCache(headers: Headers, env: AppEnv["Bindings"]): void {
  const cacheKey = getAuthCacheKey(headers);
  if (cacheKey) {
    const cache = getAuthCache(env);
    cache.revision += 1;
    cache.users.delete(cacheKey);
    cache.identities.delete(cacheKey);
  }
}

function pruneAuthCache(cache: Map<string, { expiresAt: number }>, now: number): void {
  if (cache.size <= AUTH_USER_CACHE_MAX_ENTRIES) return;
  for (const [key, value] of cache) {
    if (value.expiresAt <= now || cache.size > AUTH_USER_CACHE_MAX_ENTRIES) {
      cache.delete(key);
    }
    if (cache.size <= AUTH_USER_CACHE_MAX_ENTRIES) return;
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
  const cache = getAuthCache(env);
  const revision = cache.revision;
  if (!hasSessionCredentials(env, headers)) {
    throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
  }
  const auth = createAuth(env);
  const browserSession = resolveBrowserSessionHeaders(auth, headers);
  const session = await auth.api.getSession({ headers: browserSession.headers, query: { disableRefresh: true } });
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
  if (cacheKey && authCaches.get(env.DB) === cache && cache.revision === revision && sameAuthEnvironment(cache.env, env)) {
    pruneAuthCache(cache.identities, now);
    cache.identities.set(cacheKey, {
      identity,
      expiresAt: now + AUTH_USER_CACHE_TTL_MS
    });
  }
  return identity;
}

export async function resolveAuthIdentity(env: AppEnv["Bindings"], headers: Headers): Promise<AuthIdentity> {
  const now = Date.now();
  const cacheKey = getAuthCacheKey(headers);
  const cache = getAuthCache(env);
  const cachedUser = cacheKey ? cache.users.get(cacheKey) : undefined;
  if (cachedUser && cachedUser.expiresAt > now) {
    return identityFromAuthUser(cachedUser.user);
  }
  const cachedIdentity = cacheKey ? cache.identities.get(cacheKey) : undefined;
  if (cachedIdentity && cachedIdentity.expiresAt > now) {
    return cachedIdentity.identity;
  }
  return fetchAuthIdentity(env, headers, cacheKey, now);
}

async function fetchAuthUser(
  env: AppEnv["Bindings"],
  headers: Headers,
  cacheKey: string | null,
  now: number,
  verifiedIdentity?: AuthIdentity
): Promise<AuthUser> {
  const cache = getAuthCache(env);
  const revision = cache.revision;
  const identity = verifiedIdentity ?? await resolveAuthIdentity(env, headers);

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

  if (cacheKey && authCaches.get(env.DB) === cache && cache.revision === revision && sameAuthEnvironment(cache.env, env)) {
    pruneAuthCache(cache.users, now);
    cache.users.set(cacheKey, {
      user: authUser,
      expiresAt: now + AUTH_USER_CACHE_TTL_MS
    });
  }

  return authUser;
}

export async function resolveAuthUser(
  env: AppEnv["Bindings"], headers: Headers, verifiedIdentity?: AuthIdentity
): Promise<AuthUser> {
  const now = Date.now();
  const cacheKey = getAuthCacheKey(headers);
  const cached = cacheKey ? getAuthCache(env).users.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > now && (!verifiedIdentity || cached.user.uid === verifiedIdentity.uid)) {
    return cached.user;
  }
  // Never share pending D1 work between Workers requests. Completed values keep
  // the existing TTL; the Hono context already deduplicates authenticated users.
  return fetchAuthUser(env, headers, cacheKey, now, verifiedIdentity);
}

export async function resolveRequestAuthUser(
  env: AppEnv["Bindings"],
  request: Request
): Promise<AuthUser> {
  return resolveAuthUser(env, getRequestAuthHeaders(request));
}

export function getRequestAuthHeaders(request: Request): Headers {
  const url = new URL(request.url);
  return buildAuthHeaders(request.headers, url.searchParams.get("access_token"));
}

export async function resolveContextAuthUser(c: Context<AppEnv>): Promise<AuthUser> {
  const existing = c.get("authUser");
  if (existing) return existing;
  const pending = c.get("authUserPromise");
  if (pending) return pending;
  const headers = getRequestAuthHeaders(c.req.raw);
  const request = resolveAuthUser(c.env, headers);
  c.set("authUserPromise", request);
  try {
    const authUser = await request;
    c.set("authUser", authUser);
    return authUser;
  } finally {
    c.set("authUserPromise", undefined);
  }
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
