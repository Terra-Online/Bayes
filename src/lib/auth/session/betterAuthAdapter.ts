import { createAuth } from "@/lib/auth/betterAuth";
import {
  getLegacyCookieExpirations,
  resolveBrowserSessionHeaders,
  serializeBrowserSessionCookie,
} from "@/lib/auth/browserSession";
import type { Bindings } from "@/types/app";

import type { ReadSessionInput } from "./types";

export function buildSessionCredentialHeaders(input: ReadSessionInput): Headers {
  const headers = new Headers();
  if (input.cookie !== undefined) {
    headers.set("cookie", input.cookie);
  }
  if (input.authorization !== undefined) {
    headers.set("authorization", input.authorization);
  }
  const accessToken = input.accessToken?.trim();
  // The query token is a fallback. Even an empty Authorization header takes precedence.
  if (accessToken && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${accessToken}`);
  }
  return headers;
}

export function createBetterAuthSessionAdapter(env: Bindings, authHeaders: Headers) {
  const auth = createAuth(env);
  const browserSession = resolveBrowserSessionHeaders(auth, authHeaders);
  return {
    requiresCookieConfirmation: browserSession.migrating,
    async readFreshSession() {
      // This direct API call allows renewal. Ordinary authentication uses disableRefresh.
      const { response, headers } = await auth.api.getSession({
        headers: browserSession.headers,
        returnHeaders: true,
      });
      return { session: response, cookies: headers.getSetCookie() };
    },
    async createMigrationCookies(session: { token: string; expiresAt: Date }): Promise<string[]> {
      if (browserSession.migrating) {
        return [await serializeBrowserSessionCookie(auth, session)];
      }
      // Expire legacy cookies when this request does not need legacy-cookie aliasing.
      if (authHeaders.get("cookie")?.includes("better-auth.")) {
        return getLegacyCookieExpirations(auth);
      }
      return [];
    },
  };
}
