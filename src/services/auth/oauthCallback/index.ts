// To avoid confusion between Hono's request and Better Auth's inputs and outputs,
// we use explicit data for this module's interface. HTTP objects stay inside this module.

import {
  readBetterAuthResponseData,
  type BetterAuthResponseData,
} from "@/services/auth/betterAuth";
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
): Promise<BetterAuthResponseData> {
  const url = new URL(input.request.url);
  const provider = getProviderFromCallbackPath(url.pathname);
  console.warn("[auth][oauth-callback] incoming", {
    provider,
    method: input.request.method,
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
    return readBetterAuthResponseData(response);
  }
  const code = await createSessionExchangeCode(env.DB, {
    sessionToken: handoff.sessionToken,
    origin: handoff.frontendUrl.origin,
    challenge: handoff.challenge,
  });
  return readBetterAuthResponseData(
    attachSessionExchangeCode(env, url.pathname, response, handoff.frontendUrl, code),
  );
}

export async function handleOAuthError(
  env: Bindings,
  input: OAuthCallbackInput,
): Promise<BetterAuthResponseData> {
  return readBetterAuthResponseData(await invokeOAuthRequest(env, input));
}
