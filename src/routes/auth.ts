import { Context, Hono } from "hono";
import { z } from "zod";
import { createAuth } from "../lib/auth";
import { ApiError } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { formatPublicUid, getErrorMessage, updateUserNickname } from "../repositories/users";
import type { AppEnv, AuthUser } from "../types/app";

const profileUpdateSchema = z.object({
  nickname: z
    .string()
    .trim()
    .min(2, "Nickname must be at least 2 characters.")
    .max(26, "Nickname must be 26 characters or fewer.")
    .regex(/^[A-Za-z0-9_-]+$/, "Nickname can only contain letters, numbers, '_' or '-'.")
});

const sendTemplateOtpSchema = z.object({
  email: z.string().email("Invalid email address."),
  type: z.enum(["sign-in", "email-verification"]).optional(),
  locale: z.string().trim().min(1).optional(),
});

const registerWithOtpSchema = z.object({
  email: z.string().email("Invalid email address."),
  password: z.string().min(1, "Password is required."),
  otp: z.string().trim().regex(/^\d{6}$/, "OTP must be 6 digits."),
  name: z.string().trim().min(1).max(64).optional(),
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

async function readAuthErrorCode(response: Response): Promise<string | null> {
  try {
    const parsed = (await response.clone().json()) as Record<string, unknown>;
    const code = parsed.code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  } catch {
    return null;
  }

  return null;
}

async function readAuthSessionToken(response: Response): Promise<string | null> {
  try {
    const parsed = (await response.clone().json()) as Record<string, unknown>;
    const token = parsed.token;
    if (typeof token === "string" && token.length > 0) {
      return token;
    }
  } catch {
    return null;
  }

  return null;
}

function toSessionUser(user: AuthUser) {
  return {
    uid: user.publicUid,
    role: user.role,
    karma: user.karma,
    email: user.email,
    nickname: user.nickname,
    needsProfileSetup: user.needsProfileSetup
  };
}

export function createAuthRoutes() {
  const app = new Hono<AppEnv>();

  const forwardToAuthJsonPath = (
    c: Context<AppEnv>,
    path: string,
    body: Record<string, unknown>,
    options?: { headers?: Record<string, string> }
  ) => {
    const auth = createAuth(c.env);
    const targetUrl = new URL(c.req.url);
    targetUrl.pathname = `/auth/v1${path}`;

    const forwardedHeaders = new Headers(c.req.raw.headers);
    forwardedHeaders.set("content-type", "application/json");
    forwardedHeaders.set("accept", "application/json");

    if (options?.headers) {
      for (const [name, value] of Object.entries(options.headers)) {
        forwardedHeaders.set(name, value);
      }
    }

    const request = new Request(targetUrl.toString(), {
      method: "POST",
      headers: forwardedHeaders,
      body: JSON.stringify(body),
    });

    return auth.handler(request);
  };

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
    const password = parsed.data.password;
    const otp = parsed.data.otp;
    const name = parsed.data.name?.trim() || deriveDisplayName(email);

    const signInWithOtpResponse = await forwardToAuthJsonPath(c, "/sign-in/email-otp", {
      email,
      otp,
      name,
    });

    if (!signInWithOtpResponse.ok) {
      return signInWithOtpResponse;
    }

    const sessionToken = await readAuthSessionToken(signInWithOtpResponse);
    if (!sessionToken) {
      throw new ApiError(500, "AUTH_FLOW_FAILED", "Missing session token after OTP sign-in.");
    }

    const setPasswordResponse = await forwardToAuthJsonPath(
      c,
      "/set-password",
      { newPassword: password },
      {
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
      }
    );

    if (!setPasswordResponse.ok) {
      const code = await readAuthErrorCode(setPasswordResponse);
      if (code !== "PASSWORD_ALREADY_SET") {
        return setPasswordResponse;
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
    const locale = parsed.data.locale?.trim();
    const requestHeaders = locale
      ? {
          "x-oem-locale": locale,
        }
      : undefined;

    return forwardToAuthJsonPath(
      c,
      "/email-otp/send-verification-otp",
      {
        email,
        type: "sign-in",
      },
      {
        headers: requestHeaders,
      }
    );
  });

  app.get("/session", rateLimit("auth"), requireAuth, async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    return c.json({ user: toSessionUser(user) });
  });

  app.patch("/profile", rateLimit("auth"), requireAuth, async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
    let body: unknown;

    if (contentType.includes("application/json") || contentType.length === 0) {
      try {
        body = await c.req.json();
      } catch {
        const rawText = await c.req.text();
        const params = new URLSearchParams(rawText);
        const nickname = params.get("nickname");
        if (nickname !== null) {
          body = { nickname };
        } else {
          throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
        }
      }
    } else if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const form = await c.req.parseBody();
      body = {
        nickname: typeof form.nickname === "string" ? form.nickname : undefined
      };
    } else {
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported content-type for profile update.");
    }

    const parsed = profileUpdateSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid profile payload.", parsed.error.flatten());
    }

    try {
      const updated = await updateUserNickname(c.env.DB, {
        uid: user.uid,
        nickname: parsed.data.nickname
      });

      return c.json({
        user: {
          uid: formatPublicUid(updated.uidNumber, updated.uidSuffix),
          role: updated.role,
          karma: updated.karma,
          email: updated.email,
          nickname: updated.nickname,
          needsProfileSetup: !updated.nicknameCustomized
        }
      });
    } catch (error) {
      const message = getErrorMessage(error);
      if (message.includes("INVALID_NICKNAME_FORMAT")) {
        throw new ApiError(422, "INVALID_NICKNAME_FORMAT", "Nickname format is invalid.");
      }
      if (message.includes("NICKNAME_CONFLICT")) {
        throw new ApiError(409, "NICKNAME_TAKEN", "Nickname is already in use.");
      }
      if (message.includes("USER_NOT_FOUND")) {
        throw new ApiError(404, "USER_NOT_FOUND", "User profile not found.");
      }
      throw new ApiError(500, "PROFILE_UPDATE_FAILED", message);
    }
  });

  app.post("/logout", rateLimit("auth"), async (c) => {
    const auth = createAuth(c.env);
    await auth.api.signOut({
      headers: c.req.raw.headers
    });
    return c.json({ ok: true });
  });

  app.on(["GET", "POST", "OPTIONS"], "/*", (c) => {
    const auth = createAuth(c.env);
    return auth.handler(c.req.raw);
  });

  return app;
}
