import type { Context } from "hono";

import { resolveAuthIdentity } from "@/middleware/auth";
import type { LocatorIdentity } from "@/services/official/locator/access";
import type { AppEnv } from "@/types/app";

export async function resolveLocatorIdentity<E extends AppEnv>(
  c: Context<E>,
  ticketUid?: string,
): Promise<LocatorIdentity> {
  if (ticketUid) {
    return { uid: ticketUid };
  }
  const headers = new Headers(c.req.raw.headers);
  const accessToken = c.req.query("access_token")?.trim();
  if (accessToken && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${accessToken}`);
  }
  const identity = await resolveAuthIdentity(c.env, headers);
  return {
    uid: identity.uid,
    profile: { email: identity.email, displayName: identity.displayName },
  };
}
