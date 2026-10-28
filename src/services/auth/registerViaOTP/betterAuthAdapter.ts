import { ApiError, toSerializableError } from "@/lib/errors";
import { createAuth, invokeBetterAuthHandler } from "@/services/auth/betterAuth";
import type { Bindings } from "@/types/app";

type AuthOperation = "request-otp" | "register";

function invokeRegistrationOperation(
  env: Bindings,
  input: { raw_request: Request; requestId: string },
  operation: AuthOperation,
  body: Record<string, unknown>,
  locale?: string,
): Promise<Response> {
  // OTP sign-in verifies the email and creates the session used for password setup.
  return invokeBetterAuthHandler(env, input.raw_request, {
    requestId: input.requestId,
    authPath:
      operation === "request-otp" ? "/email-otp/send-verification-otp" : "/sign-in/email-otp",
    jsonBody: body,
    // The payload locale overrides the incoming email-locale header.
    // Without it, Better Auth uses the received header, browser language or default.
    headerOverrides: locale ? { "x-oem-locale": locale } : undefined,
  });
}

export function requestOtp(
  env: Bindings,
  input: { email: string; locale?: string; raw_request: Request; requestId: string },
): Promise<Response> {
  return invokeRegistrationOperation(
    env,
    input,
    "request-otp",
    // The public registration route accepts only the sign-in OTP type.
    { email: input.email, type: "sign-in" },
    input.locale,
  );
}

export async function signInWithOtp(
  env: Bindings,
  input: {
    email: string;
    otp: string;
    name: string;
    raw_request: Request;
    requestId: string;
  },
): Promise<{ result: Response; token: string | null }> {
  const response = await invokeRegistrationOperation(env, input, "register", {
    email: input.email,
    otp: input.otp,
    name: input.name,
  });
  let token: string | null = null;
  if (response.ok) {
    try {
      const parsed = (await response.clone().json()) as Record<string, unknown>;
      const user = parsed.user as Record<string, unknown> | undefined;
      if (
        typeof parsed.token === "string" &&
        parsed.token.length > 0 &&
        typeof user?.id === "string" &&
        user.id.length > 0
      ) {
        token = parsed.token;
      }
    } catch {
      // The response may have an empty or invalid JSON body.
      // The check below reports the missing session data.
    }
    if (!token) {
      throw new ApiError(500, "AUTH_FLOW_FAILED", "Missing session token after OTP sign-in.");
    }
  }
  return { result: response, token };
}

type PasswordSetupResult =
  | { kind: "set" | "already-set" }
  | { kind: "failed"; code: string | null; status: number | undefined; error: unknown };

export async function setRegistrationPassword(
  env: Bindings,
  token: string,
  password: string,
): Promise<PasswordSetupResult> {
  const auth = createAuth(env);
  try {
    // The token belongs to the session created by OTP sign-in.
    await auth.api.setPassword({
      body: { newPassword: password },
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    return { kind: "set" };
  } catch (error) {
    const code = readErrorCode(error);
    if (code === "PASSWORD_ALREADY_SET") {
      return { kind: "already-set" };
    }
    const status =
      error && typeof error === "object" && "statusCode" in error
        ? Number(error.statusCode)
        : undefined;
    return { kind: "failed", code, status, error };
  }
}

export async function revokeRegistrationSession(env: Bindings, token: string): Promise<void> {
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
