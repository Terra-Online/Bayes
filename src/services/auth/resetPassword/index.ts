import { ApiError } from "@/lib/errors";
import { invokeBetterAuthHandler } from "@/services/auth/betterAuth";
import { normalizeEmail } from "@/services/auth/contract/email";
import type { Bindings } from "@/types/app";

import { findResetUserEmail, findResetVerification } from "./previewRepository";
import type {
  PasswordResetContext,
  PasswordResetPreview,
  RequestPasswordResetInput,
  ResetPasswordInput,
} from "./types";

export type {
  PasswordResetContext,
  PasswordResetPreview,
  RequestPasswordResetInput,
  ResetPasswordInput,
} from "./types";

export function requestPasswordReset(
  env: Bindings,
  owned_input: RequestPasswordResetInput,
): Promise<Response> {
  // The caller transfers this input object. Keep raw_request and its headers unchanged.
  owned_input.email = normalizeEmail(owned_input.email);
  owned_input.locale = owned_input.locale?.trim();
  // The public /forget-password route calls Better Auth's /request-password-reset endpoint.
  return invokeBetterAuthHandler(env, owned_input.raw_request, {
    requestId: owned_input.requestId,
    authPath: "/request-password-reset",
    jsonBody: { email: owned_input.email, redirectTo: owned_input.redirectTo },
    // The payload locale overrides the incoming email-locale header.
    headerOverrides: owned_input.locale ? { "x-oem-locale": owned_input.locale } : undefined,
  });
}

export function resetPassword(env: Bindings, input: ResetPasswordInput): Promise<Response> {
  // Reject mismatched passwords before Better Auth can consume the token.
  if (input.newPassword !== input.repeatPassword) {
    throw new ApiError(400, "PASSWORD_MISMATCH", "Repeated password does not match.");
  }
  // Better Auth consumes the token before writing the password.
  // If the write fails, the token remains consumed.
  return invokeBetterAuthHandler(env, input.raw_request, {
    requestId: input.requestId,
    authPath: "/reset-password",
    jsonBody: { token: input.token, newPassword: input.newPassword },
  });
}

export async function previewPasswordReset(
  env: Bindings,
  input: { token: string },
): Promise<PasswordResetPreview> {
  const verification = await findResetVerification(env.DB, input.token);
  const expiresAt = verification ? Date.parse(verification.expiresAt) : Number.NaN;
  if (!verification || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new ApiError(400, "INVALID_TOKEN", "Reset token is invalid or expired.");
  }

  const user = await findResetUserEmail(env.DB, verification.value);
  const email = typeof user?.email === "string" ? normalizeEmail(user.email) : "";
  if (!email) {
    throw new ApiError(400, "INVALID_TOKEN", "Reset token is invalid or expired.");
  }
  return { ok: true, tokenValid: true, email };
}

export function followPasswordResetLink(
  env: Bindings,
  input: PasswordResetContext,
): Promise<Response> {
  // The email link already contains Better Auth's path, token and callbackURL.
  // Keep the original URL, method and query parameters, including HEAD requests.
  return invokeBetterAuthHandler(env, input.raw_request, { requestId: input.requestId });
}
