import type { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../../lib/errors";
import { rateLimit } from "../../middleware/rate-limit";
import type { AppEnv } from "../../types/app";
import { normalizeEmail } from "./emailUtils";
import type { AuthRouteContext, ForwardToAuthJsonPath } from "./types";

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

async function handlePasswordResetRequest(
  c: AuthRouteContext,
  forwardToAuthJsonPath: ForwardToAuthJsonPath
) {
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

  return forwardPasswordResetRequest(c, forwardToAuthJsonPath, parsed.data);
}

export function registerPasswordResetRoutes(
  app: Hono<AppEnv>,
  deps: {
    forwardToAuthJsonPath: ForwardToAuthJsonPath;
  },
) {
  app.post("/forget-password", rateLimit("reset-send"), async (c) => {
    return handlePasswordResetRequest(c, deps.forwardToAuthJsonPath);
  });

  app.post("/request-password-reset", rateLimit("reset-send"), async (c) => {
    return handlePasswordResetRequest(c, deps.forwardToAuthJsonPath);
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
