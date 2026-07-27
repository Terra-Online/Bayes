import { getEndfieldPosition } from "../../lib/endfieldClient/positionSocket";
import type { DecryptedBinding, DecryptedBindingCacheEntry, EndfieldBindingRow, PositionCacheEntry } from "./types";

const DECRYPTED_BINDING_CACHE_TTL_MS = 10_000;
export const POSITION_CACHE_FRESH_MS = 250;
export const POSITION_CACHE_STALE_MS = 2_500;

const decryptedBindingCache = new Map<string, DecryptedBindingCacheEntry>();
export const positionCache = new Map<string, PositionCacheEntry>();
const positionRefreshInFlight = new Map<string, Promise<PositionCacheEntry>>();

export function readDecryptedBindingCache(uid: string, now = Date.now()): DecryptedBinding | null {
  const cached = decryptedBindingCache.get(uid);
  return cached && cached.expiresAt > now ? cached : null;
}

export function writeDecryptedBindingCache(uid: string, binding: DecryptedBinding, now = Date.now()): void {
  decryptedBindingCache.set(uid, {
    ...binding,
    expiresAt: now + DECRYPTED_BINDING_CACHE_TTL_MS
  });
}

export function deleteLocatorCaches(uid: string): void {
  decryptedBindingCache.delete(uid);
  for (const key of positionCache.keys()) {
    if (key.startsWith(`${uid}:`)) {
      positionCache.delete(key);
    }
  }
  for (const key of positionRefreshInFlight.keys()) {
    if (key.startsWith(`${uid}:`)) {
      positionRefreshInFlight.delete(key);
    }
  }
}

export function getPositionCacheKey(uid: string, binding: EndfieldBindingRow): string {
  return [
    uid,
    binding.provider,
    binding.server_id,
    binding.role_id,
    binding.updated_at
  ].join(":");
}

export async function refreshPositionCache(key: string, binding: DecryptedBinding): Promise<PositionCacheEntry> {
  const inFlight = positionRefreshInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = getEndfieldPosition({
    provider: binding.binding.provider,
    roleId: binding.binding.role_id,
    serverId: Number(binding.binding.server_id),
    cred: binding.cred,
    token: binding.token,
    wsBaseUrl: binding.wsBaseUrl,
    deviceProfile: binding.deviceProfile
  })
    .then((data) => {
      const entry = {
        data,
        refreshedAt: Date.now()
      };
      positionCache.set(key, entry);
      return entry;
    })
    .finally(() => {
      positionRefreshInFlight.delete(key);
    });

  positionRefreshInFlight.set(key, promise);
  return promise;
}
