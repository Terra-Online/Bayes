// To avoid confusion between Hono's request and Better Auth's inputs and outputs,
// we use explicit data for this module's interface. The internal adapter handles
// Better Auth's Request, Headers and Response objects.

import type { BetterAuthResponseData } from "@/lib/auth/betterAuth";
import { normalizeEmail } from "@/lib/auth/contract/email";
import { isDisposableEmail } from "@/lib/auth/rules/disposableEmail";
import { ApiError, toApiError, toSerializableError } from "@/lib/errors";
import type { Bindings } from "@/types/app";

import {
  requestOtp,
  revokeRegistrationSession,
  setRegistrationPassword,
  signInWithOtp,
} from "./betterAuthAdapter";
import type { RegisterViaOTPInput, RequestRegistrationOtpInput } from "./types";

export type { RegisterViaOTPInput, RequestRegistrationOtpInput } from "./types";

// The route validates input before calling these operations.
// This order keeps an OTP usable after an input validation error.
export async function requestRegistrationOtp(
  env: Bindings,
  input: RequestRegistrationOtpInput,
): Promise<BetterAuthResponseData> {
  const email = registrationEmail(input.email);
  return requestOtp(env, { ...input, email, locale: input.locale?.trim() });
}

export async function registerViaOTP(
  env: Bindings,
  input: RegisterViaOTPInput,
): Promise<BetterAuthResponseData> {
  const email = registrationEmail(input.email);
  const signIn = await signInWithOtp(env, {
    email,
    otp: input.otp,
    name: input.name?.trim() || deriveDisplayName(email),
    request: input.request,
    requestId: input.requestId,
  });
  if (!signIn.token) {
    return signIn.result;
  }

  const password = await setRegistrationPassword(env, signIn.token, input.password);
  // If the user already has a password, registration keeps it.
  if (password.kind === "failed") {
    console.warn("[auth][register] password setup failed", {
      requestId: input.requestId,
      code: password.code,
      error: toSerializableError(password.error),
    });
    await revokeRegistrationSession(env, signIn.token);
    if (password.status && password.status >= 400 && password.status < 500) {
      throw new ApiError(
        password.status,
        password.code ?? "SET_PASSWORD_FAILED",
        "Failed to set password.",
      );
    }
    // Hono passes Error instances to the application error handler.
    throw toApiError(password.error);
  }
  return signIn.result;
}

function registrationEmail(raw: string): string {
  const email = normalizeEmail(raw);
  if (isDisposableEmail(email)) {
    throw new ApiError(
      422,
      "DISPOSABLE_EMAIL_NOT_ALLOWED",
      "Disposable email addresses are not allowed for registration.",
    );
  }
  return email;
}

function deriveDisplayName(email: string): string {
  const local = email.split("@")[0]?.trim() ?? "";
  const normalized = local.replace(/[^A-Za-z0-9_-]/g, "");
  return normalized.length >= 2 ? normalized.slice(0, 26) : "Traveler";
}
