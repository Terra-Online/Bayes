import {
  buildBetterAuthRequestHeaders,
  invokeBetterAuthHandler,
  readBetterAuthResponseData,
  type BetterAuthResponseData,
} from "@/services/auth/betterAuth";
import type { Bindings } from "@/types/app";

import type { PasswordResetContext, RequestPasswordResetInput, ResetPasswordInput } from "./types";

async function invokePasswordResetJson(
  env: Bindings,
  input: PasswordResetContext,
  authPath: string,
  body: Record<string, unknown>,
  locale?: string,
): Promise<BetterAuthResponseData> {
  const target = new URL(input.request.url);
  const publicPath = target.pathname;
  // Callers do not need to provide this prefix. Better Auth uses it as its base path.
  target.pathname = `/auth/v1${authPath}`;
  const request = new Request(target.toString(), {
    method: "POST",
    headers: buildBetterAuthRequestHeaders(input.request, {
      forceJson: true,
      // The email callback reads this header. The payload locale takes precedence.
      headers: locale ? { "x-oem-locale": locale } : undefined,
    }),
    body: JSON.stringify(body),
  });
  const response = await invokeBetterAuthHandler(env, request, {
    publicPath,
    authPath,
    requestId: input.requestId,
  });
  return readBetterAuthResponseData(response);
}

export function requestResetEmail(
  env: Bindings,
  input: RequestPasswordResetInput,
): Promise<BetterAuthResponseData> {
  // The public /forget-password route calls Better Auth's /request-password-reset endpoint.
  return invokePasswordResetJson(
    env,
    input,
    "/request-password-reset",
    { email: input.email, redirectTo: input.redirectTo },
    input.locale,
  );
}

export function submitNewPassword(
  env: Bindings,
  input: ResetPasswordInput,
): Promise<BetterAuthResponseData> {
  return invokePasswordResetJson(env, input, "/reset-password", {
    token: input.token,
    newPassword: input.newPassword,
  });
}

export async function followResetLink(
  env: Bindings,
  input: PasswordResetContext,
): Promise<BetterAuthResponseData> {
  // The email link already contains Better Auth's path, token and callbackURL.
  // Keep the original URL so Better Auth handles its query parameters and invalid paths.
  const target = new URL(input.request.url);
  const request = new Request(target.toString(), {
    // Hono dispatches HEAD through the GET route. Better Auth routes by the request method.
    method: input.request.method,
    headers: buildBetterAuthRequestHeaders(input.request),
  });
  const response = await invokeBetterAuthHandler(env, request, {
    publicPath: target.pathname,
    authPath: target.pathname.replace(/^\/auth\/v1/, ""),
    requestId: input.requestId,
  });
  return readBetterAuthResponseData(response);
}
