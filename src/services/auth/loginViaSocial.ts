import { ApiError } from "@/lib/errors";
import { createAuth, invokeBetterAuthHandler } from "@/services/auth/betterAuth";
import {
  AUTH_EXCHANGE_CHALLENGE_PARAM,
  createOAuthExchangeProof,
} from "@/services/auth/browserSession";
import {
  applyDefaultSocialCallbackUrls,
  parseTrustedFrontendOrigins,
  resolveTrustedRequestOrigin,
  toSafeTrustedUrlLog,
} from "@/services/auth/rules/frontendOrigins";
import type { Bindings } from "@/types/app";

export type BeginSocialLoginInput = {
  // The route parses JSON first. This module reads only this request's URL and headers.
  raw_request: Request;
  requestId: string;
  // The caller transfers this parsed object. Callback URLs are patched in place.
  // Better Auth validates the remaining provider-specific options.
  payload: Record<string, unknown>;
};

export async function beginSocialLogin(
  env: Bindings,
  input: BeginSocialLoginInput,
): Promise<Response> {
  const { payload: owned_payload, raw_request } = input;
  const requestOrigin = {
    origin: raw_request.headers.get("origin") ?? undefined,
    referer: raw_request.headers.get("referer") ?? undefined,
  };
  const callbackInput = {
    callbackURL:
      typeof owned_payload.callbackURL === "string" ? owned_payload.callbackURL : undefined,
    newUserCallbackURL:
      typeof owned_payload.newUserCallbackURL === "string"
        ? owned_payload.newUserCallbackURL
        : undefined,
    errorCallbackURL:
      typeof owned_payload.errorCallbackURL === "string"
        ? owned_payload.errorCallbackURL
        : undefined,
  };
  const provider = typeof owned_payload.provider === "string" ? owned_payload.provider : "unknown";
  const requestSignUp =
    typeof owned_payload.requestSignUp === "boolean" ? owned_payload.requestSignUp : null;
  const disableRedirect =
    typeof owned_payload.disableRedirect === "boolean" ? owned_payload.disableRedirect : null;
  const callbackUrls =
    applyDefaultSocialCallbackUrls(env, requestOrigin, callbackInput) ?? callbackInput;
  if (!requestOrigin.origin || !parseTrustedFrontendOrigins(env).includes(requestOrigin.origin)) {
    throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "A trusted frontend origin is required.");
  }
  const proof = await createOAuthExchangeProof(createAuth(env));
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
  // The caller transfers the parsed payload. Patch it in place and keep extra provider options.
  Object.assign(owned_payload, callbackUrls);
  const response = await invokeBetterAuthHandler(env, raw_request, {
    requestId: input.requestId,
    jsonBody: owned_payload,
  });
  if (response.ok) {
    response.headers.append("Set-Cookie", proof.cookie);
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
