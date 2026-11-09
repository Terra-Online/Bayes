import { createAuth, invokeBetterAuthHandler } from "@/services/auth/betterAuth";
import { getLegacyCookieExpirations } from "@/services/auth/browserSession";
import { invalidateSessionCache } from "@/services/auth/session";
import type { Bindings } from "@/types/app";

export type SignOutInput = {
  // The HTTP entrypoint must leave this body unread. Better Auth consumes its stream.
  raw_request: Request;
  requestId: string;
};

export async function signOut(env: Bindings, input: SignOutInput): Promise<Response> {
  const response = await invokeBetterAuthHandler(env, input.raw_request, {
    requestId: input.requestId,
  });
  if (response.ok) {
    // Cache entries use the original credentials, before Better Auth aliases legacy cookies.
    invalidateSessionCache(env, {
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
