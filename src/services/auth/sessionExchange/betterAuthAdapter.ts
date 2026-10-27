import { createAuth } from "@/services/auth/betterAuth";
import {
  expireOAuthExchangeProof,
  inspectOAuthExchangeProof,
  serializeBrowserSessionCookie,
} from "@/services/auth/browserSession";
import type { Bindings } from "@/types/app";

export function createBetterAuthExchangeAdapter(env: Bindings) {
  const auth = createAuth(env);
  return {
    inspectProof(cookie: string | undefined, challenge: string) {
      // Better Auth's cookie helpers read the browser proof from a Cookie header.
      const headers = new Headers();
      if (cookie !== undefined) {
        headers.set("cookie", cookie);
      }
      return inspectOAuthExchangeProof(auth, headers, challenge);
    },
    findSession(sessionToken: string) {
      // The token belongs to the OAuth callback's session. Incoming credentials are not used.
      return auth.api.getSession({
        query: { disableRefresh: true },
        headers: new Headers({ authorization: `Bearer ${sessionToken}` }),
      });
    },
    async createCookies(session: { token: string; expiresAt: Date }): Promise<string[]> {
      return [await serializeBrowserSessionCookie(auth, session), expireOAuthExchangeProof(auth)];
    },
  };
}
