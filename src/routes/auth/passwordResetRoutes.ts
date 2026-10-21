import type { Context } from "hono";
import { Hono } from "hono";

import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import {
  requestPasswordResetSchema,
  resetPasswordPreviewSchema,
  resetPasswordSchema,
} from "@/routes/schema/auth";
import type { AppEnv } from "@/types/app";

import { normalizeEmail } from "./emailUtils";
import { forwardToAuthJsonPath } from "./forwarding";
import type { ForwardToAuthJsonPath } from "./types";

function forwardPasswordResetRequest<E extends AppEnv<{ requestId: string }>>(
  c: Context<E>,
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

export function createRoutes(
  deps: {
    forwardToAuthJsonPath: ForwardToAuthJsonPath;
  } = { forwardToAuthJsonPath },
) {
  const app = new Hono<AppEnv<{ requestId: string }>>();

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
    const verification = await c.env.DB.prepare(
      "SELECT value, expiresAt FROM auth_verifications WHERE identifier = ?1 LIMIT 1",
    )
      .bind(identifier)
      .first<{ value: string; expiresAt: string }>();

    const expiresAt = verification ? Date.parse(verification.expiresAt) : Number.NaN;
    if (!verification || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new ApiError(400, "INVALID_TOKEN", "Reset token is invalid or expired.");
    }

    const user = await c.env.DB.prepare("SELECT email FROM auth_users WHERE id = ?1 LIMIT 1")
      .bind(verification.value)
      .first<{ email: string }>();

    const email = typeof user?.email === "string" ? normalizeEmail(user.email) : "";
    if (!email) {
      throw new ApiError(400, "INVALID_TOKEN", "Reset token is invalid or expired.");
    }

    return c.json({ ok: true, tokenValid: true, email });
  });

  return app;
}
