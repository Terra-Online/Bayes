import type { DecryptedBinding } from "@/services/official/auth/types";
import { getEndfieldPosition } from "@/services/official/client/positionSocket";
import { getLocatorCache, writePositionCache } from "@/services/official/locator/cache";
import type { PositionCacheEntry } from "@/services/official/locator/types";
import type { Bindings } from "@/types/app";

// Share only in-flight position reads within this request. Completed values use the locator cache.
export type PositionRefreshDependencies = {
  env: Bindings;
  requests: Map<string, Promise<PositionCacheEntry>>;
};

export function createPositionRefreshScope(env: Bindings): PositionRefreshDependencies {
  return { env, requests: new Map() };
}

export async function refreshPositionCache(
  { env, requests }: PositionRefreshDependencies,
  key: string,
  binding: DecryptedBinding,
): Promise<PositionCacheEntry> {
  const pending = requests.get(key);
  if (pending) {
    return pending;
  }
  const cache = getLocatorCache(env);
  const revision = cache.revision;
  const promise = getEndfieldPosition({
    provider: binding.binding.provider,
    roleId: binding.binding.role_id,
    serverId: Number(binding.binding.server_id),
    cred: binding.cred,
    token: binding.token,
    wsBaseUrl: binding.wsBaseUrl,
    deviceProfile: binding.deviceProfile,
  }).then((data) => {
    const entry = { data, refreshedAt: Date.now() };
    if (getLocatorCache(env) === cache && cache.revision === revision) {
      writePositionCache(env, key, entry);
    }
    return entry;
  });
  requests.set(key, promise);
  try {
    return await promise;
  } finally {
    if (requests.get(key) === promise) {
      requests.delete(key);
    }
  }
}
