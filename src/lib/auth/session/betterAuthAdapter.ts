import { buildSessionCredentialHeaders, createAuth } from "@/lib/auth/betterAuth";
import {
  getLegacyCookieExpirations,
  resolveBrowserSessionHeaders,
  serializeBrowserSessionCookie,
} from "@/lib/auth/browserSession";
import type { AuthCredentials } from "@/lib/auth/contract/credentials";
import type { Bindings } from "@/types/app";

export function createBetterAuthSessionAdapter(env: Bindings, credentials: AuthCredentials) {
  const auth = createAuth(env);
  const authHeaders = buildSessionCredentialHeaders(credentials);
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
