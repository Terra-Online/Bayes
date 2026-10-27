import {
  buildBetterAuthRequestHeaders,
  createAuth,
  invokeBetterAuthHandler,
  readBetterAuthResponseData,
  type BetterAuthResponseData,
} from "@/lib/auth/betterAuth";
import { createOAuthExchangeProof } from "@/lib/auth/browserSession";
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
): Promise<BetterAuthResponseData> {
  const target = new URL(input.request.url);
  const publicPath = target.pathname;
  // Better Auth dispatches social sign-in under its configured /auth/v1 base path.
  target.pathname = "/auth/v1/sign-in/social";
  const request = new Request(target.toString(), {
    method: "POST",
    headers: buildBetterAuthRequestHeaders(input.request, { forceJson: true }),
    body: JSON.stringify(body),
  });
  const response = await invokeBetterAuthHandler(env, request, {
    publicPath,
    authPath: "/sign-in/social",
    requestId: input.requestId,
  });
  if (response.ok) {
    response.headers.append("Set-Cookie", proofCookie);
  }
  response.headers.set("Cache-Control", "private, no-store");
  return readBetterAuthResponseData(response);
}
