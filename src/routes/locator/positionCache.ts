import { getEndfieldPosition } from "@/lib/endfieldClient/positionSocket";
import type { AppContext } from "@/routes/binding/types";
import type { DecryptedBinding } from "@/services/binding/types";
import { getLocatorCache, writePositionCache } from "@/services/locator/cache";
import type { PositionCacheEntry } from "@/services/locator/types";

// Pending refreshes belong to the Hono request; completed values live in the service cache.
const positionRequests = new WeakMap<AppContext, Map<string, Promise<PositionCacheEntry>>>();

export async function refreshPositionCache(
  c: AppContext,
  key: string,
  binding: DecryptedBinding,
): Promise<PositionCacheEntry> {
  let requests = positionRequests.get(c);
  if (!requests) {
    requests = new Map();
    positionRequests.set(c, requests);
  }
  const pending = requests.get(key);
  if (pending) {
    return pending;
  }
  const cache = getLocatorCache(c.env);
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
    if (getLocatorCache(c.env) === cache && cache.revision === revision) {
      writePositionCache(c.env, key, entry);
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
