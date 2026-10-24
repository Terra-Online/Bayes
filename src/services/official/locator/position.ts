import {
  createCredentialRecoveryScope,
  recoverBindingCredentials,
} from "@/services/official/auth/credentials";
import type { DecryptedBinding } from "@/services/official/auth/types";
import type { Bindings } from "@/types/app";

import { prepareLocatorAccess, type LocatorIdentity } from "./access";
import {
  getPositionCacheKey,
  POSITION_CACHE_FRESH_MS,
  POSITION_CACHE_STALE_MS,
  readPositionCache,
} from "./cache";
import {
  createPositionRefreshScope,
  refreshPositionCache,
  type PositionRefreshDependencies,
} from "./positionCache";
import { issueLocatorSocketTicket } from "./ticket";
import type { PositionCacheEntry } from "./types";

type PositionReadResult = {
  data: PositionCacheEntry["data"];
  binding: DecryptedBinding["publicBinding"];
  cacheState: "fresh" | "stale" | "miss";
  ageMs: number;
  backgroundRefresh?: Promise<void>;
};

async function readPositionWithBinding(
  uid: string,
  binding: DecryptedBinding,
  scope: PositionRefreshDependencies,
): Promise<PositionReadResult> {
  const key = getPositionCacheKey(uid, binding.binding);
  const cached = readPositionCache(scope.env, key);
  const ageMs = cached ? Date.now() - cached.refreshedAt : 0;
  if (cached && ageMs <= POSITION_CACHE_STALE_MS) {
    const fresh = ageMs <= POSITION_CACHE_FRESH_MS;
    return {
      data: cached.data,
      binding: binding.publicBinding,
      cacheState: fresh ? "fresh" : "stale",
      ageMs,
      // Preserve stale reads: background failures are ignored, without credential recovery.
      backgroundRefresh: fresh
        ? undefined
        : refreshPositionCache(scope, key, binding)
            .then(() => undefined)
            .catch(() => undefined),
    };
  }
  const position = await refreshPositionCache(scope, key, binding);
  return { data: position.data, binding: binding.publicBinding, cacheState: "miss", ageMs: 0 };
}

export async function readPosition(
  input: { identity: LocatorIdentity; includeSocketTicket?: boolean },
  env: Bindings,
): Promise<PositionReadResult & { socketTicket?: string }> {
  const { uid, binding: initialBinding } = await prepareLocatorAccess(input.identity, env);
  const socketTicket = input.includeSocketTicket
    ? await issueLocatorSocketTicket(env, uid)
    : undefined;
  const scope = createPositionRefreshScope(env);
  try {
    return { ...(await readPositionWithBinding(uid, initialBinding, scope)), socketTicket };
  } catch (rejection) {
    const binding = await recoverBindingCredentials(
      { uid, rejectedCredentials: initialBinding, rejection },
      { env, recoveryScope: createCredentialRecoveryScope() },
    );
    // The original operation retries once; recovery alone does not guarantee upstream acceptance.
    return { ...(await readPositionWithBinding(uid, binding, scope)), socketTicket };
  }
}
