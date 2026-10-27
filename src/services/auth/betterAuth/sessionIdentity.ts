import { resolveBrowserSessionHeaders } from "@/services/auth/browserSession";
import type { AuthCredentials } from "@/services/auth/contract/credentials";
import type { AuthIdentity } from "@/services/auth/identity";
import type { Bindings } from "@/types/app";

import { createAuth } from "./createAuth";
import { buildSessionCredentialHeaders } from "./transport";

export async function readSessionIdentity(
  env: Bindings,
  credentials: AuthCredentials,
): Promise<AuthIdentity | null> {
  const auth = createAuth(env);
  const headers = buildSessionCredentialHeaders(credentials);
  const browserSession = resolveBrowserSessionHeaders(auth, headers);
  // Ordinary authentication reads identity without extending the session lifetime.
  const session = await auth.api.getSession({
    headers: browserSession.headers,
    query: { disableRefresh: true },
  });
  return session
    ? {
        uid: session.user.id,
        email: session.user.email,
        displayName: session.user.name,
      }
    : null;
}
