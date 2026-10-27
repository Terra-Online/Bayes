import {
  hasSessionCredentials,
  readSessionIdentity,
  sameAuthCacheEnvironment,
} from "@/lib/auth/betterAuth";
import { resolveAuthorization, type AuthCredentials } from "@/lib/auth/contract/credentials";
import { ApiError } from "@/lib/errors";
import { ensureUserProfile, formatPublicUid } from "@/repositories/users";
import type { AppEnv, AuthUser } from "@/types/app";

export type AuthIdentity = {
  uid: string;
  email: string;
  displayName?: string;
};

const AUTH_USER_CACHE_TTL_MS = 10_000;
const AUTH_USER_CACHE_MAX_ENTRIES = 1000;

type CachedAuthUser = {
  user: AuthUser;
  expiresAt: number;
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

export async function resolveAuthIdentity(
  env: AppEnv["Bindings"],
  credentials: AuthCredentials,
): Promise<AuthIdentity> {
  const now = Date.now();
  const cacheKey = getAuthCacheKey(credentials);
  const cache = getAuthCache(env);
  const cachedUser = cacheKey ? cache.users.get(cacheKey) : undefined;
  if (cachedUser && cachedUser.expiresAt > now) {
    return identityFromAuthUser(cachedUser.user);
  }
  const cachedIdentity = cacheKey ? cache.identities.get(cacheKey) : undefined;
  if (cachedIdentity && cachedIdentity.expiresAt > now) {
    return cachedIdentity.identity;
  }
  return fetchAuthIdentity(env, credentials, cacheKey, now);
}

export async function resolveAuthUser(
  env: AppEnv["Bindings"],
  credentials: AuthCredentials,
  verifiedIdentity?: AuthIdentity,
): Promise<AuthUser> {
  const now = Date.now();
  const cacheKey = getAuthCacheKey(credentials);
  const cached = cacheKey ? getAuthCache(env).users.get(cacheKey) : undefined;
  if (
    cached &&
    cached.expiresAt > now &&
    (!verifiedIdentity || cached.user.uid === verifiedIdentity.uid)
  ) {
    return cached.user;
  }
  // Never share pending D1 work between Workers requests; cache only completed values.
  return fetchAuthUser(env, credentials, cacheKey, now, verifiedIdentity);
}

export function invalidateAuthUserCache(
  env: AppEnv["Bindings"],
  credentials: AuthCredentials,
): void {
  const cacheKey = getAuthCacheKey(credentials);
  if (cacheKey) {
    const cache = getAuthCache(env);
    cache.revision += 1;
    cache.users.delete(cacheKey);
    cache.identities.delete(cacheKey);
  }
}

function getAuthCache(env: AppEnv["Bindings"]): AuthCache {
  let cache = authCaches.get(env.DB);
  if (!cache || !sameAuthCacheEnvironment(cache.env, env)) {
    cache = { env: { ...env }, revision: 0, users: new Map(), identities: new Map() };
    authCaches.set(env.DB, cache);
  }
  return cache;
}

function getAuthCacheKey(credentials: AuthCredentials): string | null {
  const authorization = resolveAuthorization(credentials)?.trim();
  if (authorization) {
    return `authorization:${authorization}`;
  }

  const cookie = credentials.cookie?.trim();
  return cookie ? `cookie:${cookie}` : null;
}

function pruneAuthCache(cache: Map<string, { expiresAt: number }>, now: number): void {
  if (cache.size <= AUTH_USER_CACHE_MAX_ENTRIES) {
    return;
  }
  for (const [key, value] of cache) {
    if (value.expiresAt <= now || cache.size > AUTH_USER_CACHE_MAX_ENTRIES) {
      cache.delete(key);
    }
    if (cache.size <= AUTH_USER_CACHE_MAX_ENTRIES) {
      return;
    }
  }
}

function identityFromAuthUser(user: AuthUser): AuthIdentity {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.nickname,
  };
}

async function fetchAuthIdentity(
  env: AppEnv["Bindings"],
  credentials: AuthCredentials,
  cacheKey: string | null,
  now: number,
): Promise<AuthIdentity> {
  const cache = getAuthCache(env);
  const revision = cache.revision;
  if (!hasSessionCredentials(env, credentials)) {
    throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
  }
  const identity = await readSessionIdentity(env, credentials);
  if (!identity) {
    const authorization = resolveAuthorization(credentials)?.trim() ?? "";
    const hasBearerToken = authorization.toLowerCase().startsWith("bearer ");
    if (hasBearerToken) {
      throw new ApiError(401, "TOKEN_EXPIRED", "Token is expired, missing, or invalid.");
    }
    throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
  }

  if (
    cacheKey &&
    authCaches.get(env.DB) === cache &&
    cache.revision === revision &&
    sameAuthCacheEnvironment(cache.env, env)
  ) {
    pruneAuthCache(cache.identities, now);
    cache.identities.set(cacheKey, {
      identity,
      expiresAt: now + AUTH_USER_CACHE_TTL_MS,
    });
  }
  return identity;
}

async function fetchAuthUser(
  env: AppEnv["Bindings"],
  credentials: AuthCredentials,
  cacheKey: string | null,
  now: number,
  verifiedIdentity?: AuthIdentity,
): Promise<AuthUser> {
  const cache = getAuthCache(env);
  const revision = cache.revision;
  const identity = verifiedIdentity ?? (await resolveAuthIdentity(env, credentials));

  const profile = await ensureUserProfile(env.DB, {
    uid: identity.uid,
    email: identity.email,
    displayName: identity.displayName,
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
    needsProfileSetup: !profile.nicknameCustomized,
  };

  if (
    cacheKey &&
    authCaches.get(env.DB) === cache &&
    cache.revision === revision &&
    sameAuthCacheEnvironment(cache.env, env)
  ) {
    pruneAuthCache(cache.users, now);
    cache.users.set(cacheKey, {
      user: authUser,
      expiresAt: now + AUTH_USER_CACHE_TTL_MS,
    });
  }

  return authUser;
}
