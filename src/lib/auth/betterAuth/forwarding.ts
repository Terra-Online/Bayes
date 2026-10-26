import { resolveBrowserSessionHeaders } from "@/lib/auth/browserSession";
import type { Bindings } from "@/types/app";

import { createAuth } from "./createAuth";

type BetterAuthInvocationContext = {
  // This is the original public request path, for example /auth/v1/register.
  // Conflict mapping uses this path to identify registration requests.
  publicPath: string;
  // The Better Auth endpoint path excludes /auth/v1, for example /sign-in/email-otp.
  // Conflict mapping uses this path to distinguish OTP requests from OTP submissions.
  authPath: string;
  // The application supplies this tracing ID. Conflict responses include it.
  requestId: string;
};

// Better Auth's handler runs router middleware and IP rate limits.
export async function invokeBetterAuthHandler(
  env: Bindings,
  request: Request,
  context: BetterAuthInvocationContext,
): Promise<Response> {
  const errors: unknown[] = [];
  const auth = createAuth(env, { onError: (error) => errors.push(error) });
  const browserRequest = new Request(request, {
    headers: resolveBrowserSessionHeaders(auth, request.headers).headers,
  });
  try {
    const response = await auth.handler(browserRequest);
    if (response.status >= 500) {
      for (const error of errors) {
        const conflict = authConflictResponse(context, error);
        if (conflict) {
          return conflict;
        }
      }
    }
    return response;
  } catch (error) {
    for (const original of [error, ...errors]) {
      const conflict = authConflictResponse(context, original);
      if (conflict) {
        return conflict;
      }
    }
    throw error;
  }
}

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
];

const FORWARDED_HEADER_ALLOWLIST = [
  "authorization",
  "cookie",
  "user-agent",
  "accept",
  "accept-language",
  "content-type",
  "cf-connecting-ip",
  "x-request-id",
  "x-oem-locale",
  "origin",
  "referer",
];

export function buildAuthForwardHeaders(
  source: Headers,
  options?: { forceJson?: boolean; headers?: Record<string, string> },
): Headers {
  const forwardedHeaders = new Headers();

  for (const headerName of FORWARDED_HEADER_ALLOWLIST) {
    const value = source.get(headerName);
    if (value) {
      forwardedHeaders.set(headerName, value);
    }
  }

  if (options?.forceJson) {
    forwardedHeaders.set("content-type", "application/json");
    forwardedHeaders.set("accept", "application/json");
  }

  if (options?.headers) {
    for (const [name, value] of Object.entries(options.headers)) {
      forwardedHeaders.set(name, value);
    }
  }

  for (const headerName of HOP_BY_HOP_HEADERS) {
    forwardedHeaders.delete(headerName);
  }

  return forwardedHeaders;
}

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

function authConflictResponse(
  context: BetterAuthInvocationContext,
  error: unknown,
): Response | undefined {
  const constraint = uniqueConstraint(error);
  let status: number;
  let code: string;
  let message: string;
  if (constraint === "auth_users.email" && context.publicPath.endsWith("/register")) {
    status = 409;
    code = "USER_ALREADY_EXISTS";
    message = "A user with this email already exists.";
  } else if (
    constraint === "auth_verifications.identifier" &&
    context.authPath === "/email-otp/send-verification-otp"
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
    ].includes(context.authPath)
  ) {
    status = 400;
    code = "INVALID_OTP";
    message = "Verification code could not be used. Please request a new code.";
  } else {
    return undefined;
  }
  return new Response(JSON.stringify({ code, message, requestId: context.requestId }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      ...(status === 429 ? { "retry-after": "1" } : {}),
    },
  });
}
