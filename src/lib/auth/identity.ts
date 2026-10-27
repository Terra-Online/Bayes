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

type Cached<T> = {
  value: T;
  expiresAt: number;
};

type AuthCache = {
  env: AppEnv["Bindings"];
  revision: number;
  users: Map<string, Cached<AuthUser>>;
  identities: Map<string, Cached<AuthIdentity>>;
};
type AuthLookup = {
  // Auth bindings remain unchanged while this lookup is in progress.
  env: AppEnv["Bindings"];
  cache: AuthCache;
  key: string | null;
  revision: number;
  now: number;
};

const authCaches = new WeakMap<D1Database, AuthCache>();

export async function resolveAuthIdentity(
  env: AppEnv["Bindings"],
  credentials: AuthCredentials,
): Promise<AuthIdentity> {
  const lookup = beginAuthLookup(env, credentials);
  const user = readCached(lookup, lookup.cache.users);
  if (user) {
    return identityFromAuthUser(user);
  }
  return resolveIdentity(credentials, lookup);
}

export async function resolveAuthUser(
  env: AppEnv["Bindings"],
  credentials: AuthCredentials,
  verifiedIdentity?: AuthIdentity,
): Promise<AuthUser> {
  const lookup = beginAuthLookup(env, credentials);
  const user = readCached(lookup, lookup.cache.users);
  if (user && (!verifiedIdentity || user.uid === verifiedIdentity.uid)) {
    return user;
  }
  const identity = verifiedIdentity ?? (await resolveIdentity(credentials, lookup));
  return loadAuthUser(identity, lookup);
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

function beginAuthLookup(env: AppEnv["Bindings"], credentials: AuthCredentials): AuthLookup {
  const now = Date.now();
  const key = getAuthCacheKey(credentials);
  const cache = getAuthCache(env);
  return { env, cache, key, revision: cache.revision, now };
}

function readCached<T>(lookup: AuthLookup, values: Map<string, Cached<T>>): T | undefined {
  const cached = lookup.key ? values.get(lookup.key) : undefined;
  return cached && cached.expiresAt > lookup.now ? cached.value : undefined;
}

function storeCompleted<T>(lookup: AuthLookup, values: Map<string, Cached<T>>, value: T): void {
  const { env, cache, key, revision, now } = lookup;
  // Invalidated or replaced caches must not receive results from older lookups.
  if (key && authCaches.get(env.DB) === cache && cache.revision === revision) {
    // Never share pending D1 work between Workers requests; cache only completed values.
    pruneAuthCache(values, now);
    values.set(key, { value, expiresAt: now + AUTH_USER_CACHE_TTL_MS });
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

async function resolveIdentity(
  credentials: AuthCredentials,
  lookup: AuthLookup,
): Promise<AuthIdentity> {
  const { env } = lookup;
  const cached = readCached(lookup, lookup.cache.identities);
  if (cached) {
    return cached;
  }
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

  storeCompleted(lookup, lookup.cache.identities, identity);
  return identity;
}

async function loadAuthUser(identity: AuthIdentity, lookup: AuthLookup): Promise<AuthUser> {
  const profile = await ensureUserProfile(lookup.env.DB, {
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

  storeCompleted(lookup, lookup.cache.users, authUser);

  return authUser;
}
