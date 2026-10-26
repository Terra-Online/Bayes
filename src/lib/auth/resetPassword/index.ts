// To avoid confusion between Hono's request and Better Auth's inputs and outputs,
// we use explicit data for this module's interface. The internal adapter handles
// Better Auth's Request, Headers and Response objects.

import type { BetterAuthResponseData } from "@/lib/auth/betterAuth";
import { normalizeEmail } from "@/lib/auth/contract/email";
import { ApiError } from "@/lib/errors";
import type { Bindings } from "@/types/app";

import { followResetLink, requestResetEmail, submitNewPassword } from "./betterAuthAdapter";
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
  input: RequestPasswordResetInput,
): Promise<BetterAuthResponseData> {
  return requestResetEmail(env, {
    ...input,
    email: normalizeEmail(input.email),
    locale: input.locale?.trim(),
  });
}

export function resetPassword(
  env: Bindings,
  input: ResetPasswordInput,
): Promise<BetterAuthResponseData> {
  // Reject mismatched passwords before Better Auth can consume the token.
  if (input.newPassword !== input.repeatPassword) {
    throw new ApiError(400, "PASSWORD_MISMATCH", "Repeated password does not match.");
  }
  // Better Auth consumes the token before writing the password.
  // If the write fails, the token remains consumed.
  return submitNewPassword(env, input);
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
): Promise<BetterAuthResponseData> {
  // Link validation and preview only read the token. Submission consumes it.
  return followResetLink(env, input);
}
