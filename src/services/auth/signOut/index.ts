import { createAuth } from "@/services/auth/betterAuth";
import { getLegacyCookieExpirations } from "@/services/auth/browserSession";
import { invalidateAuthUserCache } from "@/services/auth/identity";
import type { Bindings } from "@/types/app";

import { invokeSignOut } from "./betterAuthAdapter";
import type { SignOutInput } from "./types";

export type { SignOutInput } from "./types";

export async function signOut(env: Bindings, input: SignOutInput): Promise<Response> {
  const response = await invokeSignOut(env, input);
  if (response.ok) {
    // Cache entries use the original credentials, before Better Auth aliases legacy cookies.
    invalidateAuthUserCache(env, {
      cookie: input.raw_request.headers.get("cookie") ?? undefined,
      authorization: input.raw_request.headers.get("authorization") ?? undefined,
    });
    for (const cookie of getLegacyCookieExpirations(createAuth(env))) {
      response.headers.append("Set-Cookie", cookie);
    }
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
