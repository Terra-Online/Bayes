// To avoid confusion between Hono's request and Better Auth's inputs and outputs,
// we use explicit data for this module's interface. HTTP objects stay inside this module.

import {
  createAuth,
  readBetterAuthResponseData,
  type BetterAuthResponseData,
} from "@/services/auth/betterAuth";
import { getLegacyCookieExpirations } from "@/services/auth/browserSession";
import { invalidateAuthUserCache } from "@/services/auth/identity";
import type { Bindings } from "@/types/app";

import { invokeSignOut } from "./betterAuthAdapter";
import type { SignOutInput } from "./types";

export type { SignOutInput } from "./types";

export async function signOut(env: Bindings, input: SignOutInput): Promise<BetterAuthResponseData> {
  const response = await invokeSignOut(env, input);
  if (response.ok) {
    // Cache entries use the original credentials, before Better Auth aliases legacy cookies.
    invalidateAuthUserCache(env, {
      cookie: input.request.cookie,
      authorization: input.request.authorization,
    });
    for (const cookie of getLegacyCookieExpirations(createAuth(env))) {
      response.headers.append("Set-Cookie", cookie);
    }
  }
  response.headers.set("Cache-Control", "private, no-store");
  return readBetterAuthResponseData(response);
}
