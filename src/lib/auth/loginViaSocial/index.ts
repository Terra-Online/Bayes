// To avoid confusion between Hono's request and Better Auth's inputs and outputs,
// we use explicit data for this module's interface. HTTP objects stay inside the adapter.

import type { BetterAuthResponseData } from "@/lib/auth/betterAuth";
import { AUTH_EXCHANGE_CHALLENGE_PARAM } from "@/lib/auth/browserSession";
import {
  applyDefaultSocialCallbackUrls,
  parseTrustedFrontendOrigins,
  resolveTrustedRequestOrigin,
  toSafeTrustedUrlLog,
} from "@/lib/auth/rules/frontendOrigins";
import { ApiError } from "@/lib/errors";
import type { Bindings } from "@/types/app";

import { createSocialLoginProof, invokeSocialSignIn } from "./betterAuthAdapter";
import type { BeginSocialLoginInput } from "./types";

export type { BeginSocialLoginInput } from "./types";

export async function beginSocialLogin(
  env: Bindings,
  input: BeginSocialLoginInput,
): Promise<BetterAuthResponseData> {
  const { payload, request } = input;
  const callbackInput = {
    callbackURL: typeof payload.callbackURL === "string" ? payload.callbackURL : undefined,
    newUserCallbackURL:
      typeof payload.newUserCallbackURL === "string" ? payload.newUserCallbackURL : undefined,
    errorCallbackURL:
      typeof payload.errorCallbackURL === "string" ? payload.errorCallbackURL : undefined,
  };
  const provider = typeof payload.provider === "string" ? payload.provider : "unknown";
  const requestSignUp = typeof payload.requestSignUp === "boolean" ? payload.requestSignUp : null;
  const disableRedirect =
    typeof payload.disableRedirect === "boolean" ? payload.disableRedirect : null;
  const callbackUrls = applyDefaultSocialCallbackUrls(env, request, callbackInput) ?? callbackInput;
  if (!request.origin || !parseTrustedFrontendOrigins(env).includes(request.origin)) {
    throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "A trusted frontend origin is required.");
  }
  const proof = await createSocialLoginProof(env);
  for (const key of ["callbackURL", "newUserCallbackURL"] as const) {
    const rawUrl = callbackUrls[key];
    if (rawUrl === undefined) {
      continue;
    }
    const callback = new URL(rawUrl);
    callback.searchParams.set(AUTH_EXCHANGE_CHALLENGE_PARAM, proof.challenge);
    callbackUrls[key] = callback.toString();
  }
  console.warn("[auth][social-sign-in] forwarding", {
    provider,
    requestSignUp,
    disableRedirect,
    requestOrigin: resolveTrustedRequestOrigin(env, request),
    callbackURL: toSafeTrustedUrlLog(env, callbackUrls.callbackURL ?? null),
    newUserCallbackURL: toSafeTrustedUrlLog(env, callbackUrls.newUserCallbackURL ?? null),
    errorCallbackURL: toSafeTrustedUrlLog(env, callbackUrls.errorCallbackURL ?? null),
  });
  return invokeSocialSignIn(env, input, { ...payload, ...callbackUrls }, proof.cookie);
}
