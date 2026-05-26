import { Context, Hono } from "hono";
import { z } from "zod";
import { createAuth } from "../lib/auth";
import { ApiError } from "../lib/errors";
import { isDisposableEmail } from "../lib/disposable-email";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { ensureUserProfile, formatPublicUid, getErrorMessage, updateUserNickname } from "../repositories/users";
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
  "x-request-id",
  "x-oem-locale",
  "origin",
  "referer",
];

const DEFAULT_TRUSTED_FRONTEND_ORIGINS = [
  "https://opendfieldmap.org",
  "https://www.opendfieldmap.org",
  "https://beta.opendfieldmap.org",
  "https://opendfieldmap.cn",
  "https://www.opendfieldmap.cn",
];

const LOCAL_TRUSTED_FRONTEND_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5429",
  "http://127.0.0.1:5429",
];

const DEFAULT_AUTH_ORIGIN = "https://api.opendfieldmap.org";
const SESSION_EXCHANGE_CODE_PREFIX = "auth-session-exchange:";
const SESSION_EXCHANGE_CODE_TTL_SECONDS = 120;

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

function isLocalBackendUrl(raw: string | undefined): boolean {
  if (!raw || raw.trim().length === 0) {
    return false;
  }

  try {
    const url = new URL(raw.trim());
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function parseTrustedFrontendOrigins(env: AppEnv["Bindings"]): string[] {
  const raw = env.TRUSTED_ORIGINS ?? env.CORS_ORIGINS;
  const backendOrigins = new Set(
    [DEFAULT_AUTH_ORIGIN, readOriginFromUrl(env.BETTER_AUTH_URL ?? null)].filter(
      (origin): origin is string => origin !== null,
    ),
  );

  if (!raw || raw.trim().length === 0) {
    return isLocalBackendUrl(env.BETTER_AUTH_URL)
      ? LOCAL_TRUSTED_FRONTEND_ORIGINS
      : DEFAULT_TRUSTED_FRONTEND_ORIGINS;
  }

  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !backendOrigins.has(item));

  return parsed.length > 0 ? parsed : DEFAULT_TRUSTED_FRONTEND_ORIGINS;
}

function readOriginFromUrl(raw: string | null): string | null {
  if (!raw) {
    return null;
  }

  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return null;
  }
}

function resolveTrustedRequestOrigin(c: Context<AppEnv>): string | null {
  const trustedOrigins = parseTrustedFrontendOrigins(c.env);
  const candidates = [
    c.req.header("origin")?.trim() || null,
    readOriginFromUrl(c.req.header("referer") ?? null),
  ];

  return candidates.find((origin) => origin !== null && trustedOrigins.includes(origin)) ?? null;
}

function resolveTrustedCallbackUrl(
  c: Context<AppEnv>,
  raw: unknown,
  baseOrigin: string,
): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }

  const value = raw.trim();
  if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")) {
    return new URL(value, baseOrigin).toString();
  }

  try {
    const url = new URL(value);
    return parseTrustedFrontendOrigins(c.env).includes(url.origin) ? url.toString() : null;
  } catch {
    return null;
  }
}

function applyDefaultSocialCallbackUrls(c: Context<AppEnv>, body: Record<string, unknown>) {
  const defaultOrigin = resolveTrustedRequestOrigin(c);
  if (!defaultOrigin) {
    return body;
  }

  const nextBody = { ...body };
  const callbackURL = resolveTrustedCallbackUrl(c, nextBody.callbackURL, defaultOrigin) ?? defaultOrigin;
  nextBody.callbackURL = callbackURL;
  nextBody.newUserCallbackURL =
    resolveTrustedCallbackUrl(c, nextBody.newUserCallbackURL, defaultOrigin) ?? callbackURL;
  nextBody.errorCallbackURL =
    resolveTrustedCallbackUrl(c, nextBody.errorCallbackURL, defaultOrigin) ?? callbackURL;

  return nextBody;
}

function splitSetCookieHeader(setCookie: string): string[] {
  const result: string[] = [];
  let start = 0;
  let index = 0;

  while (index < setCookie.length) {
    if (setCookie[index] === ",") {
      let cursor = index + 1;
      while (cursor < setCookie.length && setCookie[cursor] === " ") {
        cursor += 1;
      }
      while (
        cursor < setCookie.length
        && setCookie[cursor] !== "="
        && setCookie[cursor] !== ";"
        && setCookie[cursor] !== ","
      ) {
        cursor += 1;
      }
      if (cursor < setCookie.length && setCookie[cursor] === "=") {
        const part = setCookie.slice(start, index).trim();
        if (part) {
          result.push(part);
        }
        start = index + 1;
        while (start < setCookie.length && setCookie[start] === " ") {
          start += 1;
        }
        index = start;
        continue;
      }
    }
    index += 1;
  }

  const last = setCookie.slice(start).trim();
  if (last) {
    result.push(last);
  }
  return result;
}

function readSessionTokenFromSetCookie(setCookie: string | null): string | null {
  if (!setCookie) {
    return null;
  }

  for (const cookie of splitSetCookieHeader(setCookie)) {
    const [nameValue] = cookie.split(";", 1);
    const separatorIndex = nameValue?.indexOf("=") ?? -1;
    if (!nameValue || separatorIndex < 0) {
      continue;
    }

    const name = nameValue.slice(0, separatorIndex).trim();
    if (name !== "__Secure-better-auth.session_token" && name !== "better-auth.session_token") {
      continue;
    }

    const value = nameValue.slice(separatorIndex + 1);
    if (!value) {
      return null;
    }

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

function readSessionTokenFromResponse(response: Response): string | null {
  const authToken = response.headers.get("set-auth-token")?.trim();
  if (authToken) {
    return authToken;
  }

  return readSessionTokenFromSetCookie(response.headers.get("set-cookie"));
}

function appendQueryParam(rawUrl: string, name: string, value: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set(name, value);
  return url.toString();
}

function getProviderFromCallbackPath(path: string): string {
  return path.split("/").pop() || "unknown";
}

function toSafeUrlLog(raw: string | null): {
  origin: string | null;
  pathname: string | null;
  hasError: boolean;
  hasAuthCode: boolean;
  trusted: boolean | null;
} {
  if (!raw) {
    return {
      origin: null,
      pathname: null,
      hasError: false,
      hasAuthCode: false,
      trusted: null,
    };
  }

  try {
    const url = new URL(raw);
    return {
      origin: url.origin,
      pathname: url.pathname,
      hasError: url.searchParams.has("error"),
      hasAuthCode: url.searchParams.has("auth_code"),
      trusted: null,
    };
  } catch {
    return {
      origin: null,
      pathname: null,
      hasError: false,
      hasAuthCode: false,
      trusted: null,
    };
  }
}

function toSafeTrustedUrlLog(c: Context<AppEnv>, raw: string | null) {
  const details = toSafeUrlLog(raw);
  if (!raw) {
    return details;
  }

  return {
    ...details,
    trusted: isTrustedCallbackUrlForResponse(c, raw),
  };
}

async function createSessionExchangeCode(
  env: AppEnv["Bindings"],
  sessionToken: string,
): Promise<string> {
  const code = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_EXCHANGE_CODE_TTL_SECONDS * 1000).toISOString();
  await env.DB
    .prepare(
      `INSERT INTO auth_verifications (id, identifier, value, expiresAt, createdAt, updatedAt)
       VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .bind(
      crypto.randomUUID(),
      `${SESSION_EXCHANGE_CODE_PREFIX}${code}`,
      sessionToken,
      expiresAt,
    )
    .run();
  return code;
}

async function attachSessionExchangeCode(c: Context<AppEnv>, response: Response): Promise<Response> {
  if (!response.status.toString().startsWith("3")) {
    return response;
  }

  const location = response.headers.get("location");
  if (!location || !isTrustedCallbackUrlForResponse(c, location)) {
    console.warn("[auth][oauth-callback] skipped session exchange code", {
      provider: getProviderFromCallbackPath(c.req.path),
      status: response.status,
      hasLocation: Boolean(location),
      location: toSafeTrustedUrlLog(c, location),
      hasSetCookie: Boolean(response.headers.get("set-cookie")),
      hasSetAuthToken: Boolean(response.headers.get("set-auth-token")),
    });
    return response;
  }

  const sessionToken = readSessionTokenFromResponse(response);
  if (!sessionToken) {
    console.warn("[auth][oauth-callback] missing session token for exchange code", {
      provider: getProviderFromCallbackPath(c.req.path),
      status: response.status,
      hasLocation: Boolean(location),
      location: toSafeTrustedUrlLog(c, location),
      hasSetCookie: Boolean(response.headers.get("set-cookie")),
      hasSetAuthToken: Boolean(response.headers.get("set-auth-token")),
    });
    return response;
  }

  const code = await createSessionExchangeCode(c.env, sessionToken);
  const headers = new Headers(response.headers);
  headers.set("location", appendQueryParam(location, "auth_code", code));
  console.warn("[auth][oauth-callback] attached session exchange code", {
    provider: getProviderFromCallbackPath(c.req.path),
    status: response.status,
    location: toSafeTrustedUrlLog(c, location),
    hasSetCookie: Boolean(response.headers.get("set-cookie")),
    hasSetAuthToken: Boolean(response.headers.get("set-auth-token")),
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isTrustedCallbackUrlForResponse(c: Context<AppEnv>, raw: string): boolean {
  try {
    const url = new URL(raw);
    return parseTrustedFrontendOrigins(c.env).includes(url.origin);
  } catch {
    return false;
  }
}

const profileUpdateSchema = z.object({
  nickname: z
    .string()
    .trim()
    .min(2, "Nickname must be at least 2 characters.")
    .max(26, "Nickname must be 26 characters or fewer.")
    .regex(/^[A-Za-z0-9_-]+$/, "Nickname can only contain letters, numbers, '_' or '-'."),
  avatar: z.number().int().min(1).max(99).optional(),
  avt: z.number().int().min(1).max(99).optional(),
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

const sessionExchangeSchema = z.object({
  code: z.string().trim().min(16, "Code is required."),
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
    avatar: user.avatar,
    email: user.email,
    nickname: user.nickname,
    registeredAt: user.registeredAt,
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

  const forwardPasswordResetRequest = (
    c: AuthRouteContext,
    payload: {
      email: string;
      redirectTo: string;
      locale?: string;
    },
  ) => {
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
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return forwardToAuthRawRequest(c);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.");
    }

    const payload = body as Record<string, unknown>;
    const rawEmail = payload.email;
    if (typeof rawEmail !== "string") {
      return forwardToAuthJsonPath(c, "/sign-in/email", payload);
    }

    const email = normalizeEmail(rawEmail);
    payload.email = email;
    return forwardToAuthJsonPath(c, "/sign-in/email", payload);
  });

  app.post("/sign-in/social", rateLimit("public"), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return forwardToAuthRawRequest(c);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.");
    }

    const nextBody = applyDefaultSocialCallbackUrls(c, body as Record<string, unknown>);
    const provider = typeof nextBody.provider === "string" ? nextBody.provider : "unknown";
    console.warn("[auth][social-sign-in] forwarding", {
      provider,
      requestOrigin: resolveTrustedRequestOrigin(c),
      callbackURL: toSafeTrustedUrlLog(
        c,
        typeof nextBody.callbackURL === "string" ? nextBody.callbackURL : null,
      ),
      newUserCallbackURL: toSafeTrustedUrlLog(
        c,
        typeof nextBody.newUserCallbackURL === "string" ? nextBody.newUserCallbackURL : null,
      ),
      errorCallbackURL: toSafeTrustedUrlLog(
        c,
        typeof nextBody.errorCallbackURL === "string" ? nextBody.errorCallbackURL : null,
      ),
    });

    return forwardToAuthJsonPath(
      c,
      "/sign-in/social",
      nextBody,
    );
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

    return forwardPasswordResetRequest(c, parsed.data);
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

    return forwardPasswordResetRequest(c, parsed.data);
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

    return forwardToAuthJsonPath(c, "/reset-password", {
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

  app.get("/get-session", rateLimit("public"), async (c) => {
    return forwardToAuthRawRequest(c);
  });

  app.post("/session/exchange", rateLimit("public"), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
    }

    const parsed = sessionExchangeSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.", parsed.error.flatten());
    }

    const identifier = `${SESSION_EXCHANGE_CODE_PREFIX}${parsed.data.code}`;
    const verification = await c.env.DB
      .prepare("SELECT value, expiresAt FROM auth_verifications WHERE identifier = ?1 LIMIT 1")
      .bind(identifier)
      .first<{ value: string; expiresAt: string }>();

    await c.env.DB
      .prepare("DELETE FROM auth_verifications WHERE identifier = ?1")
      .bind(identifier)
      .run();

    const expiresAt = verification ? Date.parse(verification.expiresAt) : Number.NaN;
    if (!verification || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new ApiError(400, "INVALID_AUTH_CODE", "Auth code is invalid or expired.");
    }

    const auth = createAuth(c.env);
    const session = await auth.api.getSession({
      headers: new Headers({
        authorization: `Bearer ${verification.value}`,
      }),
    });

    if (!session) {
      throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
    }

    const profile = await ensureUserProfile(c.env.DB, {
      uid: session.user.id,
      email: session.user.email,
      displayName: session.user.name,
    });

    return c.json({
      token: verification.value,
      user: toSessionUser({
        uid: profile.uid,
        publicUid: formatPublicUid(profile.uidNumber, profile.uidSuffix),
        role: profile.role,
        karma: profile.karma,
        avatar: profile.avt,
        email: profile.email,
        nickname: profile.nickname,
        registeredAt: profile.createdAt,
        needsProfileSetup: !profile.nicknameCustomized,
      }),
    });
  });

  app.post("/sign-out", rateLimit("public"), async (c) => {
    return forwardToAuthRawRequest(c);
  });

  app.get("/reset-password/*", rateLimit("public"), async (c) => {
    return forwardToAuthRawRequest(c);
  });

  app.on(["GET", "POST", "OPTIONS"], "/callback/*", rateLimit("public"), async (c) => {
    console.warn("[auth][oauth-callback] incoming", {
      provider: getProviderFromCallbackPath(c.req.path),
      method: c.req.method,
      hasState: Boolean(c.req.query("state")),
      hasCode: Boolean(c.req.query("code")),
      hasError: Boolean(c.req.query("error")),
    });
    const response = await forwardToAuthRawRequest(c);
    const location = response.headers.get("location");
    console.warn("[auth][oauth-callback] response", {
      provider: getProviderFromCallbackPath(c.req.path),
      status: response.status,
      hasLocation: Boolean(location),
      location: toSafeTrustedUrlLog(c, location),
      hasSetCookie: Boolean(response.headers.get("set-cookie")),
      hasSetAuthToken: Boolean(response.headers.get("set-auth-token")),
    });
    return attachSessionExchangeCode(c, response);
  });

  app.get("/error", rateLimit("public"), async (c) => {
    return forwardToAuthRawRequest(c);
  });

  app.get("/session", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    return c.json({ user: toSessionUser(user) });
  });

  app.patch("/profile", requireAuth, rateLimit("auth"), async (c) => {
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
      const rawAvatar = typeof form.avatar === "string"
        ? Number(form.avatar)
        : typeof form.avt === "string"
          ? Number(form.avt)
          : undefined;
      body = {
        nickname: typeof form.nickname === "string" ? form.nickname : undefined,
        avatar: rawAvatar,
      };
    } else {
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported content-type for profile update.");
    }

    if (body && typeof body === "object" && !Array.isArray(body)) {
      const nextBody = { ...(body as Record<string, unknown>) };
      if (nextBody.avatar === undefined && nextBody.avt !== undefined) {
        nextBody.avatar = nextBody.avt;
      }
      body = nextBody;
    }

    const parsed = profileUpdateSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid profile payload.", parsed.error.flatten());
    }

    try {
      const updated = await updateUserNickname(c.env.DB, {
        uid: user.uid,
        nickname: parsed.data.nickname,
        avatar: parsed.data.avatar
      });

      return c.json({
        user: {
          uid: formatPublicUid(updated.uidNumber, updated.uidSuffix),
          role: updated.role,
          karma: updated.karma,
          avatar: updated.avt,
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
      if (message.includes("INVALID_AVATAR")) {
        throw new ApiError(422, "INVALID_AVATAR", "Avatar is invalid.");
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
