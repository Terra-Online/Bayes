import type { Context } from "hono";

import { resolveAuthIdentity } from "@/lib/auth/identity";
import { getRequestAuthCredentials } from "@/lib/auth/requestCredentials";
import type { LocatorIdentity } from "@/services/official/locator/access";
import type { AppEnv } from "@/types/app";

export async function resolveLocatorIdentity<E extends AppEnv>(
  c: Context<E>,
  ticketUid?: string,
): Promise<LocatorIdentity> {
  if (ticketUid) {
    return { uid: ticketUid };
  }
  const identity = await resolveAuthIdentity(c.env, getRequestAuthCredentials(c.req.raw));
  return {
    uid: identity.uid,
    profile: { email: identity.email, displayName: identity.displayName },
  };
}
