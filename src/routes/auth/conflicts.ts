import type { Context } from "hono";

import type { AppEnv } from "@/types/app";

function uniqueConstraint(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const cause = current as { message?: unknown; cause?: unknown };
    if (typeof cause.message === "string") {
      const match =
        /UNIQUE constraint failed: (auth_users\.email|auth_verifications\.identifier)(?=\s*(?:$|: SQLITE_|\[))/i.exec(
          cause.message,
        );
      if (match) {
        return match[1]!.toLowerCase();
      }
    }
    current = cause.cause;
  }
  return undefined;
}

export function authConflictResponse<E extends AppEnv<{ requestId: string }>>(
  c: Context<E>,
  path: string,
  error: unknown,
): Response | undefined {
  const constraint = uniqueConstraint(error);
  let status: number;
  let code: string;
  let message: string;
  if (constraint === "auth_users.email" && c.req.path.endsWith("/register")) {
    status = 409;
    code = "USER_ALREADY_EXISTS";
    message = "A user with this email already exists.";
  } else if (
    constraint === "auth_verifications.identifier" &&
    path === "/email-otp/send-verification-otp"
  ) {
    status = 429;
    code = "RATE_LIMITED";
    message = "Please wait before requesting another verification code.";
  } else if (
    constraint === "auth_verifications.identifier" &&
    [
      "/sign-in/email-otp",
      "/email-otp/verify-email",
      "/email-otp/reset-password",
      "/email-otp/change-email",
    ].includes(path)
  ) {
    status = 400;
    code = "INVALID_OTP";
    message = "Verification code could not be used. Please request a new code.";
  } else {
    return undefined;
  }
  return new Response(JSON.stringify({ code, message, requestId: c.get("requestId") }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      ...(status === 429 ? { "retry-after": "1" } : {}),
    },
  });
}
