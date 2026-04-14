import { Context, Hono } from "hono";
import { z } from "zod";
import { createAuth } from "../lib/auth";
import { ApiError } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { formatPublicUid, getErrorMessage, updateUserNickname } from "../repositories/users";
import type { AppEnv, AuthUser } from "../types/app";

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
  "x-forwarded-for",
  "x-real-ip",
  "x-request-id",
  "x-oem-locale",
  "origin",
  "referer",
];

function buildForwardHeaders(
  source: Headers,
  options?: { forceJson?: boolean; headers?: Record<string, string> }
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
  type AuthRouteContext = Context<AppEnv>;

  const forwardToAuthJsonPath = (
    c: AuthRouteContext,
    path: string,
    body: Record<string, unknown>,
    options?: { headers?: Record<string, string> }
  ) => {
    const auth = createAuth(c.env);
    const targetUrl = new URL(c.req.url);
    targetUrl.pathname = `/auth/v1${path}`;

    const forwardedHeaders = buildForwardHeaders(c.req.raw.headers, {
      forceJson: true,
      headers: options?.headers,
    });

    const request = new Request(targetUrl.toString(), {
      method: "POST",
      headers: forwardedHeaders,
      body: JSON.stringify(body),
    });

    return auth.handler(request);
  };

  const forwardToAuthRawRequest = (c: AuthRouteContext) => {
    const auth = createAuth(c.env);
    const targetUrl = new URL(c.req.url);
    const method = c.req.method.toUpperCase();
    const hasRequestBody = !["GET", "HEAD"].includes(method);

    const forwardedHeaders = buildForwardHeaders(c.req.raw.headers);

    const request = new Request(targetUrl.toString(), {
      method,
      headers: forwardedHeaders,
      body: hasRequestBody ? c.req.raw.body : undefined,
    });

    return auth.handler(request);
  };

  const rollbackRegisterSideEffects = async (input: {
    env: AppEnv["Bindings"];
    sessionToken: string;
    userId: string;
    email: string;
    existedBefore: boolean;
  }) => {
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

    const existing = await c.env.DB
      .prepare("SELECT id FROM auth_users WHERE email = ?1 LIMIT 1")
      .bind(email)
      .first<{ id: string }>();

    const existedBefore = Boolean(existing?.id);

    const signInWithOtpResponse = await forwardToAuthJsonPath(c, "/sign-in/email-otp", {
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
        type: parsed.data.type,
      },
      {
        headers: requestHeaders,
      }
    );
  });

  app.post("/sign-in/email", rateLimit("public"), async (c) => {
    return forwardToAuthRawRequest(c);
  });

  app.post("/sign-in/social", rateLimit("public"), async (c) => {
    return forwardToAuthRawRequest(c);
  });

  app.post("/forget-password", rateLimit("public"), async (c) => {
    return forwardToAuthRawRequest(c);
  });

  app.post("/request-password-reset", rateLimit("public"), async (c) => {
    return forwardToAuthRawRequest(c);
  });

  app.post("/reset-password", rateLimit("public"), async (c) => {
    return forwardToAuthRawRequest(c);
  });

  app.get("/get-session", async (c) => {
    return forwardToAuthRawRequest(c);
  });

  app.post("/sign-out", async (c) => {
    return forwardToAuthRawRequest(c);
  });

  app.get("/reset-password/*", rateLimit("public"), async (c) => {
    return forwardToAuthRawRequest(c);
  });

  app.on(["GET", "POST", "OPTIONS"], "/callback/*", rateLimit("public"), async (c) => {
    return forwardToAuthRawRequest(c);
  });

  app.get("/error", rateLimit("public"), async (c) => {
    return forwardToAuthRawRequest(c);
  });

  app.get("/session", requireAuth, async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    return c.json({ user: toSessionUser(user) });
  });

  app.patch("/profile", requireAuth, async (c) => {
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
        throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
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

  app.post("/logout", async (c) => {
    const auth = createAuth(c.env);
    await auth.api.signOut({
      headers: c.req.raw.headers
    });
    return c.json({ ok: true });
  });

  app.on(["GET", "POST", "OPTIONS"], "/*", async () => {
    throw new ApiError(404, "NOT_FOUND", "Not found.");
  });

  return app;
}
