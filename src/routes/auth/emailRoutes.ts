import type { Hono } from "hono";

import { createAuth } from "@/lib/auth/createAuth";
import { toSerializableError } from "@/lib/auth/errors";
import { isDisposableEmail } from "@/lib/email/disposable";
import { ApiError } from "@/lib/errors";
import { toApiError } from "@/middleware/error-handler";
import { rateLimit } from "@/middleware/rate-limit";
import { sendTemplateOtpSchema, registerWithOtpSchema } from "@/routes/schema/auth";
import type { AppEnv } from "@/types/app";

import { deriveDisplayName, normalizeEmail } from "./emailUtils";
import type { ForwardToAuthJsonPath, ForwardToAuthRawRequest } from "./types";

type AuthSignInResult = {
  token: string;
  userId: string;
};

async function readAuthSignInResult(response: Response): Promise<AuthSignInResult | null> {
  try {
    const parsed = (await response.clone().json()) as Record<string, unknown>;
    const token = parsed.token;
    const user = parsed.user as Record<string, unknown> | undefined;
    const userId = user?.id;
    if (
      typeof token === "string" &&
      token.length > 0 &&
      typeof userId === "string" &&
      userId.length > 0
    ) {
      return {
        token,
        userId,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function readCodeFromUnknownError(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const maybeError = error as {
    code?: unknown;
    body?: { code?: unknown };
    cause?: { code?: unknown; body?: { code?: unknown } };
  };

  if (typeof maybeError.code === "string" && maybeError.code.length > 0) {
    return maybeError.code;
  }

  if (typeof maybeError.body?.code === "string" && maybeError.body.code.length > 0) {
    return maybeError.body.code;
  }

  if (typeof maybeError.cause?.code === "string" && maybeError.cause.code.length > 0) {
    return maybeError.cause.code;
  }

  if (typeof maybeError.cause?.body?.code === "string" && maybeError.cause.body.code.length > 0) {
    return maybeError.cause.body.code;
  }

  return null;
}

async function revokeRegistrationSession(input: { env: AppEnv["Bindings"]; sessionToken: string }) {
  const auth = createAuth(input.env);

  try {
    await auth.api.signOut({
      headers: new Headers({
        authorization: `Bearer ${input.sessionToken}`,
      }),
    });
  } catch (error) {
    console.error("[auth][register] failed to revoke session during rollback", {
      error: toSerializableError(error),
    });
  }
}

export function registerEmailAuthRoutes(
  app: Hono<AppEnv>,
  deps: {
    forwardToAuthJsonPath: ForwardToAuthJsonPath;
    forwardToAuthRawRequest: ForwardToAuthRawRequest;
  },
) {
  app.post("/register", rateLimit("public"), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
    }

    const parsed = registerWithOtpSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.", parsed.error.flatten());
    }

    const email = normalizeEmail(parsed.data.email);
    if (isDisposableEmail(email)) {
      throw new ApiError(
        422,
        "DISPOSABLE_EMAIL_NOT_ALLOWED",
        "Disposable email addresses are not allowed for registration.",
      );
    }

    const password = parsed.data.password;
    const otp = parsed.data.otp;
    const name = parsed.data.name?.trim() || deriveDisplayName(email);

    const signInWithOtpResponse = await deps.forwardToAuthJsonPath(c, "/sign-in/email-otp", {
      email,
      otp,
      name,
    });

    if (!signInWithOtpResponse.ok) {
      return signInWithOtpResponse;
    }

    const signInResult = await readAuthSignInResult(signInWithOtpResponse);
    if (!signInResult) {
      throw new ApiError(500, "AUTH_FLOW_FAILED", "Missing session token after OTP sign-in.");
    }

    const auth = createAuth(c.env);
    try {
      await auth.api.setPassword({
        body: { newPassword: password },
        headers: new Headers({
          authorization: `Bearer ${signInResult.token}`,
        }),
      });
    } catch (error) {
      const code = readCodeFromUnknownError(error);
      if (code !== "PASSWORD_ALREADY_SET") {
        console.warn("[auth][register] password setup failed", {
          requestId: c.get("requestId"),
          code,
          error: toSerializableError(error),
        });
        await revokeRegistrationSession({
          env: c.env,
          sessionToken: signInResult.token,
        });

        const status =
          error && typeof error === "object" && "statusCode" in error
            ? Number(error.statusCode)
            : undefined;
        if (status && status >= 400 && status < 500) {
          throw new ApiError(status, code ?? "SET_PASSWORD_FAILED", "Failed to set password.");
        }
        throw toApiError(error);
      }
    }

    return signInWithOtpResponse;
  });

  app.post("/email-otp/send-verification-otp", rateLimit("otp-send"), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
    }

    const parsed = sendTemplateOtpSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.", parsed.error.flatten());
    }

    const email = normalizeEmail(parsed.data.email);
    if (isDisposableEmail(email)) {
      throw new ApiError(
        422,
        "DISPOSABLE_EMAIL_NOT_ALLOWED",
        "Disposable email addresses are not allowed for registration.",
      );
    }

    const locale = parsed.data.locale?.trim();
    const requestHeaders = locale
      ? {
          "x-oem-locale": locale,
        }
      : undefined;

    return deps.forwardToAuthJsonPath(
      c,
      "/email-otp/send-verification-otp",
      {
        email,
        type: parsed.data.type,
      },
      {
        headers: requestHeaders,
      },
    );
  });

  app.post("/sign-in/email", rateLimit("public"), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return deps.forwardToAuthRawRequest(c);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.");
    }

    const payload = body as Record<string, unknown>;
    const rawEmail = payload.email;
    if (typeof rawEmail !== "string") {
      return deps.forwardToAuthJsonPath(c, "/sign-in/email", payload);
    }

    const email = normalizeEmail(rawEmail);
    payload.email = email;
    return deps.forwardToAuthJsonPath(c, "/sign-in/email", payload);
  });
}
