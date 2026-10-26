import {
  buildBetterAuthRequestHeaders,
  invokeBetterAuthHandler,
  readBetterAuthResponseData,
  type BetterAuthResponseData,
} from "@/lib/auth/betterAuth";
import type { Bindings } from "@/types/app";

import type { LoginViaPasswordInput } from "./types";

export async function signInWithPassword(
  env: Bindings,
  input: LoginViaPasswordInput,
): Promise<BetterAuthResponseData> {
  const target = new URL(input.request.url);
  const publicPath = target.pathname;
  // Better Auth exposes password login at this path under its configured base path.
  target.pathname = "/auth/v1/sign-in/email";
  const request = new Request(target.toString(), {
    method: "POST",
    headers: buildBetterAuthRequestHeaders(input.request, { forceJson: true }),
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      rememberMe: input.rememberMe,
      callbackURL: input.callbackURL,
      redirectTo: input.redirectTo,
      errorCallbackURL: input.errorCallbackURL,
      newUserCallbackURL: input.newUserCallbackURL,
    }),
  });
  const response = await invokeBetterAuthHandler(env, request, {
    publicPath,
    authPath: "/sign-in/email",
    requestId: input.requestId,
  });
  return readBetterAuthResponseData(response);
}
