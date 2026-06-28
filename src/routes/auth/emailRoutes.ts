import type { Context, Hono } from "hono";
import { z } from "zod";
import { createAuth } from "../../lib/auth";
import { isDisposableEmail } from "../../lib/email/disposable";
import { ApiError } from "../../lib/errors";
import { rateLimit } from "../../middleware/rate-limit";
import type { AppEnv } from "../../types/app";

type AuthRouteContext = Context<AppEnv>;

type ForwardToAuthJsonPath = (
  c: AuthRouteContext,
  path: string,
  body: Record<string, unknown>,
  options?: { headers?: Record<string, string> }
) => Response | Promise<Response>;

type ForwardToAuthRawRequest = (c: AuthRouteContext) => Response | Promise<Response>;

type AuthSignInResult = {
  token: string;
  userId: string;
};

const sendTemplateOtpSchema = z.object({
  email: z.string().email("Invalid email address."),
  type: z.literal("sign-in").default("sign-in"),
  locale: z.string().trim().min(1).optional(),
});

const registerWithOtpSchema = z.object({
  email: z.string().email("Invalid email address."),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(20, "Password must be 20 characters or fewer.")
    .regex(/[A-Z]/, "Password must include at least one uppercase letter.")
    .regex(/^\S+$/, "Password cannot contain spaces."),
  otp: z.string().trim().regex(/^\d{6}$/, "OTP must be 6 digits."),
  name: z.string().trim().min(1).max(64).optional(),
});

const requestPasswordResetSchema = z.object({
  email: z.string().email("Invalid email address."),
  redirectTo: z.string().url("Invalid redirect URL."),
  locale: z.string().trim().min(1).optional(),
});

const resetPasswordSchema = z.object({
  token: z.string().trim().min(1, "Token is required."),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(20, "Password must be 20 characters or fewer.")
    .regex(/[A-Z]/, "Password must include at least one uppercase letter.")
    .regex(/^\S+$/, "Password cannot contain spaces."),
  repeatPassword: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(20, "Password must be 20 characters or fewer.")
    .regex(/[A-Z]/, "Password must include at least one uppercase letter.")
    .regex(/^\S+$/, "Password cannot contain spaces."),
});

const resetPasswordPreviewSchema = z.object({
  token: z.string().trim().min(1, "Token is required."),
});

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function deriveDisplayName(email: string): string {
  const local = email.split("@")[0]?.trim() ?? "";
  const normalized = local.replace(/[^A-Za-z0-9_-]/g, "");
  if (normalized.length >= 2) {
    return normalized.slice(0, 26);
  }
  return "Traveler";
}

async function readAuthSignInResult(response: Response): Promise<AuthSignInResult | null> {
  try {
    const parsed = (await response.clone().json()) as Record<string, unknown>;
    const token = parsed.token;
    const user = parsed.user as Record<string, unknown> | undefined;
    const userId = user?.id;
    if (
      typeof token === "string"
      && token.length > 0
      && typeof userId === "string"
      && userId.length > 0
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

  if (
    typeof maybeError.cause?.body?.code === "string"
    && maybeError.cause.body.code.length > 0
  ) {
    return maybeError.cause.body.code;
  }

  return null;
}

function forwardPasswordResetRequest(
  c: AuthRouteContext,
  forwardToAuthJsonPath: ForwardToAuthJsonPath,
  payload: {
    email: string;
    redirectTo: string;
    locale?: string;
  },
) {
  const email = normalizeEmail(payload.email);
  const locale = payload.locale?.trim();
  const requestHeaders = locale
    ? {
        "x-oem-locale": locale,
      }
    : undefined;

  return forwardToAuthJsonPath(
    c,
    "/request-password-reset",
    {
      email,
      redirectTo: payload.redirectTo,
    },
    {
      headers: requestHeaders,
    },
  );
}

async function rollbackRegisterSideEffects(input: {
  env: AppEnv["Bindings"];
  sessionToken: string;
  userId: string;
  email: string;
  existedBefore: boolean;
}) {
  const auth = createAuth(input.env);

  try {
    await auth.api.signOut({
      headers: new Headers({
        authorization: `Bearer ${input.sessionToken}`,
      }),
    });
  } catch (error) {
    console.error("[auth][register] failed to revoke session during rollback", error);
  }

  if (!input.existedBefore) {
    await input.env.DB
      .prepare("DELETE FROM auth_users WHERE id = ?1 AND email = ?2")
      .bind(input.userId, input.email)
      .run();
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

    const existing = await c.env.DB
      .prepare("SELECT id FROM auth_users WHERE email = ?1 LIMIT 1")
      .bind(email)
      .first<{ id: string }>();

    const existedBefore = Boolean(existing?.id);

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
        await rollbackRegisterSideEffects({
          env: c.env,
          sessionToken: signInResult.token,
          userId: signInResult.userId,
          email,
          existedBefore,
        });

        throw new ApiError(400, code ?? "SET_PASSWORD_FAILED", "Failed to set password.");
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
      }
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

  app.post("/forget-password", rateLimit("reset-send"), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
    }

    const parsed = requestPasswordResetSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.", parsed.error.flatten());
    }

    return forwardPasswordResetRequest(c, deps.forwardToAuthJsonPath, parsed.data);
  });

  app.post("/request-password-reset", rateLimit("reset-send"), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
    }

    const parsed = requestPasswordResetSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.", parsed.error.flatten());
    }

    return forwardPasswordResetRequest(c, deps.forwardToAuthJsonPath, parsed.data);
  });

  app.post("/reset-password", rateLimit("public"), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
    }

    const parsed = resetPasswordSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.", parsed.error.flatten());
    }

    if (parsed.data.newPassword !== parsed.data.repeatPassword) {
      throw new ApiError(400, "PASSWORD_MISMATCH", "Repeated password does not match.");
    }

    return deps.forwardToAuthJsonPath(c, "/reset-password", {
      token: parsed.data.token,
      newPassword: parsed.data.newPassword,
    });
  });

  app.get("/reset-password-preview", rateLimit("public"), async (c) => {
    const parsed = resetPasswordPreviewSchema.safeParse({
      token: c.req.query("token"),
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.", parsed.error.flatten());
    }

    const identifier = `reset-password:${parsed.data.token}`;
    const verification = await c.env.DB
      .prepare("SELECT value, expiresAt FROM auth_verifications WHERE identifier = ?1 LIMIT 1")
      .bind(identifier)
      .first<{ value: string; expiresAt: string }>();

    const expiresAt = verification ? Date.parse(verification.expiresAt) : Number.NaN;
    if (!verification || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new ApiError(400, "INVALID_TOKEN", "Reset token is invalid or expired.");
    }

    const user = await c.env.DB
      .prepare("SELECT email FROM auth_users WHERE id = ?1 LIMIT 1")
      .bind(verification.value)
      .first<{ email: string }>();

    const email = typeof user?.email === "string" ? normalizeEmail(user.email) : "";
    if (!email) {
      throw new ApiError(400, "INVALID_TOKEN", "Reset token is invalid or expired.");
    }

    return c.json({ ok: true, tokenValid: true, email });
  });
}
