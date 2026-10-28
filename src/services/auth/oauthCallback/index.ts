import { toSafeTrustedUrlLog } from "@/services/auth/rules/frontendOrigins";
import { createSessionExchangeCode } from "@/services/auth/sessionExchange";
import type { Bindings } from "@/types/app";

import {
  attachSessionExchangeCode,
  getProviderFromCallbackPath,
  inspectSessionHandoff,
  invokeOAuthRequest,
} from "./betterAuthAdapter";
import type { OAuthCallbackInput } from "./types";

export type { OAuthCallbackInput } from "./types";

export async function completeOAuthCallback(
  env: Bindings,
  input: OAuthCallbackInput,
): Promise<Response> {
  const url = new URL(input.raw_request.url);
  const provider = getProviderFromCallbackPath(url.pathname);
  console.warn("[auth][oauth-callback] incoming", {
    provider,
    method: input.raw_request.method,
    hasState: Boolean(url.searchParams.get("state")),
    hasCode: Boolean(url.searchParams.get("code")),
    hasError: Boolean(url.searchParams.get("error")),
  });
  const response = await invokeOAuthRequest(env, input);
  const location = response.headers.get("location");
  console.warn("[auth][oauth-callback] response", {
    provider,
    status: response.status,
    hasLocation: Boolean(location),
    location: toSafeTrustedUrlLog(env, location),
    hasSetCookie: Boolean(response.headers.get("set-cookie")),
    hasSetAuthToken: Boolean(response.headers.get("set-auth-token")),
  });
  // Better Auth validates state and completes login or binding before returning this response.
  const handoff = inspectSessionHandoff(env, url.pathname, response);
  if (!handoff) {
    return response;
  }
  const code = await createSessionExchangeCode(env.DB, {
    sessionToken: handoff.sessionToken,
    origin: handoff.frontendUrl.origin,
    challenge: handoff.challenge,
  });
  return attachSessionExchangeCode(env, url.pathname, response, handoff.frontendUrl, code);
}

export function handleOAuthError(env: Bindings, input: OAuthCallbackInput): Promise<Response> {
  return invokeOAuthRequest(env, input);
}
