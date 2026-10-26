import {
  buildBetterAuthRequestHeaders,
  readBetterAuthResponseData,
  type BetterAuthRequestInfo,
  type BetterAuthResponseData,
  createAuth,
  invokeBetterAuthHandler,
} from "@/lib/auth/betterAuth";
import { ApiError, toSerializableError } from "@/lib/errors";
import type { Bindings } from "@/types/app";

type AuthOperation = "request-otp" | "register";

async function invokeRegistrationOperation(
  env: Bindings,
  input: { request: BetterAuthRequestInfo; requestId: string },
  operation: AuthOperation,
  body: Record<string, unknown>,
  locale?: string,
): Promise<Response> {
  const source = input.request;
  // Callers do not need to provide these paths.
  // These paths are required by Better Auth plugins.
  // OTP sign-in verifies the email and creates a session.
  // Password setup uses this session to identify the user.
  const authPath =
    operation === "request-otp" ? "/email-otp/send-verification-otp" : "/sign-in/email-otp";
  const target = new URL(source.url);
  const publicPath = target.pathname;
  target.pathname = `/auth/v1${authPath}`;
  const request = new Request(target.toString(), {
    method: "POST",
    headers: buildBetterAuthRequestHeaders(source, {
      forceJson: true,
      // The email callback reads x-oem-locale. The payload locale overrides
      // the incoming header. If neither provides a locale, the callback uses
      // the browser language or the deployment default.
      headers: locale ? { "x-oem-locale": locale } : undefined,
    }),
    body: JSON.stringify(body),
  });
  return invokeBetterAuthHandler(env, request, {
    publicPath,
    authPath,
    requestId: input.requestId,
  });
}

export async function requestOtp(
  env: Bindings,
  input: { email: string; locale?: string; request: BetterAuthRequestInfo; requestId: string },
): Promise<BetterAuthResponseData> {
  const response = await invokeRegistrationOperation(
    env,
    input,
    "request-otp",
    // The public registration route accepts only the sign-in OTP type.
    { email: input.email, type: "sign-in" },
    input.locale,
  );
  return readBetterAuthResponseData(response);
}

export async function signInWithOtp(
  env: Bindings,
  input: {
    email: string;
    otp: string;
    name: string;
    request: BetterAuthRequestInfo;
    requestId: string;
  },
): Promise<{ result: BetterAuthResponseData; token: string | null }> {
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
  return { result: await readBetterAuthResponseData(response), token };
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
