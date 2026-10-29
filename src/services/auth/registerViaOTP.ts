import { ApiError, toApiError, toSerializableError } from "@/lib/errors";
import { createAuth, invokeBetterAuthHandler } from "@/services/auth/betterAuth";
import { normalizeEmail } from "@/services/auth/contract/email";
import { isDisposableEmail } from "@/services/auth/rules/disposableEmail";
import type { Bindings } from "@/types/app";

type RegistrationContext = {
  // The route parses JSON first. This module reads only this request's URL and headers.
  raw_request: Request;
  requestId: string;
};

// The caller transfers this object. Email and locale are normalized in place.
// The raw_request field remains borrowed and is not modified.
export type RequestRegistrationOtpInput = RegistrationContext & {
  email: string;
  locale?: string;
};

export type RegisterViaOTPInput = RegistrationContext & {
  email: string;
  otp: string;
  password: string;
  name?: string;
};

// The route validates input before calling these operations.
// This order keeps an OTP usable after an input validation error.
export async function requestRegistrationOtp(
  env: Bindings,
  owned_input: RequestRegistrationOtpInput,
): Promise<Response> {
  // The caller transfers this input object. Keep raw_request and its headers unchanged.
  owned_input.email = registrationEmail(owned_input.email);
  owned_input.locale = owned_input.locale?.trim();
  return invokeBetterAuthHandler(env, owned_input.raw_request, {
    requestId: owned_input.requestId,
    authPath: "/email-otp/send-verification-otp",
    // The public registration route accepts only the sign-in OTP type.
    jsonBody: { email: owned_input.email, type: "sign-in" },
    // The payload locale overrides the incoming email-locale header.
    // Without it, Better Auth uses the received header, browser language or default.
    headerOverrides: owned_input.locale ? { "x-oem-locale": owned_input.locale } : undefined,
  });
}

export async function registerViaOTP(env: Bindings, input: RegisterViaOTPInput): Promise<Response> {
  const email = registrationEmail(input.email);
  // OTP sign-in verifies the email and creates the session used for password setup.
  const response = await invokeBetterAuthHandler(env, input.raw_request, {
    requestId: input.requestId,
    authPath: "/sign-in/email-otp",
    jsonBody: {
      email,
      otp: input.otp,
      name: input.name?.trim() || deriveDisplayName(email),
    },
  });
  if (!response.ok) {
    return response;
  }
  const token = await readRegistrationToken(response);
  const auth = createAuth(env);
  try {
    // The token belongs to the session created by OTP sign-in.
    await auth.api.setPassword({
      body: { newPassword: input.password },
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
  } catch (error) {
    const code = readErrorCode(error);
    // If the user already has a password, registration keeps it.
    if (code !== "PASSWORD_ALREADY_SET") {
      const status =
        error && typeof error === "object" && "statusCode" in error
          ? Number(error.statusCode)
          : undefined;
      console.warn("[auth][register] password setup failed", {
        requestId: input.requestId,
        code,
        error: toSerializableError(error),
      });
      await revokeRegistrationSession(env, token);
      if (status && status >= 400 && status < 500) {
        throw new ApiError(status, code ?? "SET_PASSWORD_FAILED", "Failed to set password.");
      }
      // Hono passes Error instances to the application error handler.
      throw toApiError(error);
    }
  }
  return response;
}

async function readRegistrationToken(better_auth_response: Response): Promise<string> {
  try {
    const parsed = (await better_auth_response.clone().json()) as Record<string, unknown>;
    const user = parsed.user as Record<string, unknown> | undefined;
    if (
      typeof parsed.token === "string" &&
      parsed.token.length > 0 &&
      typeof user?.id === "string" &&
      user.id.length > 0
    ) {
      return parsed.token;
    }
  } catch {
    // The response may have an empty or invalid JSON body.
  }
  throw new ApiError(500, "AUTH_FLOW_FAILED", "Missing session token after OTP sign-in.");
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

async function revokeRegistrationSession(env: Bindings, token: string): Promise<void> {
  const auth = createAuth(env);
  try {
    await auth.api.signOut({ headers: new Headers({ authorization: `Bearer ${token}` }) });
  } catch (error) {
    // If sign-out fails, registration still reports the password setup error.
    // The verified user remains in storage.
    console.error("[auth][register] failed to revoke session during rollback", {
      error: toSerializableError(error),
    });
  }
}

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  // Better Auth may put the error code in code or body.code.
  // A wrapped error may put the same fields in cause.
  const candidate = error as {
    code?: unknown;
    body?: { code?: unknown };
    cause?: { code?: unknown; body?: { code?: unknown } };
  };
  for (const code of [
    candidate.code,
    candidate.body?.code,
    candidate.cause?.code,
    candidate.cause?.body?.code,
  ]) {
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return null;
}
