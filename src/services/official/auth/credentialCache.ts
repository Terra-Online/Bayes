import { deleteLocatorCaches } from "@/services/official/locator/cache";
import type { Bindings } from "@/types/app";

import type { DecryptedBinding } from "./types";

const CACHE_TTL_MS = 10_000;
const MAX_CACHE_ENTRIES = 1000;
type CredentialCache = {
  secret?: string;
  wsBaseUrl?: string;
  revision: number;
  bindings: Map<string, DecryptedBinding & { expiresAt: number }>;
};
const caches = new WeakMap<D1Database, CredentialCache>();

export function getCredentialCache(env: Bindings): CredentialCache {
  const secret = env.ENDFIELD_CREDENTIAL_SECRET ?? env.BETTER_AUTH_SECRET;
  let cache = caches.get(env.DB);
  if (!cache || cache.secret !== secret || cache.wsBaseUrl !== env.ENDFIELD_WS_BASE_URL) {
    cache = { secret, wsBaseUrl: env.ENDFIELD_WS_BASE_URL, revision: 0, bindings: new Map() };
    caches.set(env.DB, cache);
  }
  return cache;
}

export function readDecryptedBindingCache(
  env: Bindings,
  uid: string,
  now = Date.now(),
): DecryptedBinding | null {
  const cache = getCredentialCache(env).bindings;
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
  const cache = getCredentialCache(env).bindings;
  cache.delete(uid);
  cache.set(uid, { ...binding, expiresAt: Date.now() + CACHE_TTL_MS });
  if (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value!);
  }
}

export function invalidateBindingCaches(env: Bindings, uid: string): void {
  const cache = getCredentialCache(env);
  cache.revision += 1;
  cache.bindings.delete(uid);
  // Position values and in-flight position reads belong to locator, but depend on this identity.
  deleteLocatorCaches(env, uid);
}
