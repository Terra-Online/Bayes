import { createAuth, invokeBetterAuthHandler } from "@/services/auth/betterAuth";
import { createOAuthExchangeProof } from "@/services/auth/browserSession";
import type { Bindings } from "@/types/app";

import type { BeginSocialLoginInput } from "./types";

export function createSocialLoginProof(
  env: Bindings,
): Promise<{ challenge: string; cookie: string }> {
  return createOAuthExchangeProof(createAuth(env));
}

export async function invokeSocialSignIn(
  env: Bindings,
  input: BeginSocialLoginInput,
  body: Record<string, unknown>,
  proofCookie: string,
): Promise<Response> {
  const response = await invokeBetterAuthHandler(env, input.raw_request, {
    requestId: input.requestId,
    jsonBody: body,
  });
  if (response.ok) {
    response.headers.append("Set-Cookie", proofCookie);
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
