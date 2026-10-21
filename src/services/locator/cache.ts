import type { EndfieldBindingRow } from "@/repositories/binding/types";
import type { DecryptedBinding, DecryptedBindingCacheEntry } from "@/services/binding/types";
import type { PositionCacheEntry } from "@/services/locator/types";
import type { Bindings } from "@/types/app";

const DECRYPTED_BINDING_CACHE_TTL_MS = 10_000;
const MAX_CACHE_ENTRIES = 1000;
export const POSITION_CACHE_FRESH_MS = 250;
export const POSITION_CACHE_STALE_MS = 2_500;

type LocatorCache = {
  secret?: string;
  wsBaseUrl?: string;
  revision: number;
  bindings: Map<string, DecryptedBindingCacheEntry>;
  positions: Map<string, PositionCacheEntry>;
};
const caches = new WeakMap<D1Database, LocatorCache>();

export function getLocatorCache(env: Bindings): LocatorCache {
  const secret = env.ENDFIELD_CREDENTIAL_SECRET ?? env.BETTER_AUTH_SECRET;
  let cache = caches.get(env.DB);
  if (!cache || cache.secret !== secret || cache.wsBaseUrl !== env.ENDFIELD_WS_BASE_URL) {
    cache = {
      secret,
      wsBaseUrl: env.ENDFIELD_WS_BASE_URL,
      revision: 0,
      bindings: new Map(),
      positions: new Map(),
    };
    caches.set(env.DB, cache);
  }
  return cache;
}

function cacheValue<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value!);
  }
}

export function readDecryptedBindingCache(
  env: Bindings,
  uid: string,
  now = Date.now(),
): DecryptedBinding | null {
  const cache = getLocatorCache(env).bindings;
  const cached = cache.get(uid);
  if (cached && cached.expiresAt > now) {
    return cached;
  }
  cache.delete(uid);
  return null;
}

export function writeDecryptedBindingCache(
  env: Bindings,
  uid: string,
  binding: DecryptedBinding,
): void {
  cacheValue(getLocatorCache(env).bindings, uid, {
    ...binding,
    expiresAt: Date.now() + DECRYPTED_BINDING_CACHE_TTL_MS,
  });
}

export function deleteLocatorCaches(env: Bindings, uid: string): void {
  const cache = getLocatorCache(env);
  cache.revision += 1;
  cache.bindings.delete(uid);
  for (const key of cache.positions.keys()) {
    if (key.startsWith(`${uid}:`)) {
      cache.positions.delete(key);
    }
  }
}

export function readPositionCache(env: Bindings, key: string): PositionCacheEntry | undefined {
  return getLocatorCache(env).positions.get(key);
}

export function writePositionCache(env: Bindings, key: string, entry: PositionCacheEntry): void {
  cacheValue(getLocatorCache(env).positions, key, entry);
}

export function getPositionCacheKey(uid: string, binding: EndfieldBindingRow): string {
  return [uid, binding.provider, binding.server_id, binding.role_id, binding.updated_at].join(":");
}
