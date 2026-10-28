import { invokeBetterAuthHandler } from "@/services/auth/betterAuth";
import type { Bindings } from "@/types/app";

import type { PasswordResetContext, RequestPasswordResetInput, ResetPasswordInput } from "./types";

function invokePasswordResetJson(
  env: Bindings,
  input: PasswordResetContext,
  authPath: string,
  body: Record<string, unknown>,
  locale?: string,
): Promise<Response> {
  return invokeBetterAuthHandler(env, input.raw_request, {
    requestId: input.requestId,
    authPath,
    jsonBody: body,
    // The payload locale overrides the incoming email-locale header.
    headerOverrides: locale ? { "x-oem-locale": locale } : undefined,
  });
}

export function requestResetEmail(
  env: Bindings,
  input: RequestPasswordResetInput,
): Promise<Response> {
  // The public /forget-password route calls Better Auth's /request-password-reset endpoint.
  return invokePasswordResetJson(
    env,
    input,
    "/request-password-reset",
    { email: input.email, redirectTo: input.redirectTo },
    input.locale,
  );
}

export function submitNewPassword(env: Bindings, input: ResetPasswordInput): Promise<Response> {
  return invokePasswordResetJson(env, input, "/reset-password", {
    token: input.token,
    newPassword: input.newPassword,
  });
}

export function followResetLink(env: Bindings, input: PasswordResetContext): Promise<Response> {
  // The email link already contains Better Auth's path, token and callbackURL.
  // Keep the original URL, method and query parameters, including HEAD requests.
  return invokeBetterAuthHandler(env, input.raw_request, { requestId: input.requestId });
}
