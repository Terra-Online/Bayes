import { ApiError } from "@/lib/errors";
import { AUTH_EXCHANGE_CHALLENGE_PARAM } from "@/services/auth/browserSession";
import {
  applyDefaultSocialCallbackUrls,
  parseTrustedFrontendOrigins,
  resolveTrustedRequestOrigin,
  toSafeTrustedUrlLog,
} from "@/services/auth/rules/frontendOrigins";
import type { Bindings } from "@/types/app";

import { createSocialLoginProof, invokeSocialSignIn } from "./betterAuthAdapter";
import type { BeginSocialLoginInput } from "./types";

export type { BeginSocialLoginInput } from "./types";

export async function beginSocialLogin(
  env: Bindings,
  input: BeginSocialLoginInput,
): Promise<Response> {
  const { payload, raw_request } = input;
  const requestOrigin = {
    origin: raw_request.headers.get("origin") ?? undefined,
    referer: raw_request.headers.get("referer") ?? undefined,
  };
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
  const callbackUrls =
    applyDefaultSocialCallbackUrls(env, requestOrigin, callbackInput) ?? callbackInput;
  if (!requestOrigin.origin || !parseTrustedFrontendOrigins(env).includes(requestOrigin.origin)) {
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
    requestOrigin: resolveTrustedRequestOrigin(env, requestOrigin),
    callbackURL: toSafeTrustedUrlLog(env, callbackUrls.callbackURL ?? null),
    newUserCallbackURL: toSafeTrustedUrlLog(env, callbackUrls.newUserCallbackURL ?? null),
    errorCallbackURL: toSafeTrustedUrlLog(env, callbackUrls.errorCallbackURL ?? null),
  });
  return invokeSocialSignIn(env, input, { ...payload, ...callbackUrls }, proof.cookie);
}
