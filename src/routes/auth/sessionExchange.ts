import { z } from "zod";
import { createAuth } from "../../lib/auth/createAuth";
import { expireOAuthExchangeProof, serializeBrowserSessionCookie, verifyOAuthExchangeProof } from "../../lib/auth/browserSession";
import { ApiError } from "../../lib/errors";
import { ensureUserProfile, formatPublicUid } from "../../repositories/users";
import { toSessionUser } from "./sessionUser";
import type { AuthRouteContext } from "./types";
import { parseTrustedFrontendOrigins } from "./frontendOrigins";

const SESSION_EXCHANGE_CODE_PREFIX = "auth-session-exchange:";
const SESSION_EXCHANGE_CODE_TTL_SECONDS = 120;
const exchangeValueSchema = z.object({
  token: z.string().min(1),
  origin: z.string().url(),
  challenge: z.string().regex(/^[a-f0-9]{64}$/),
});

export const sessionExchangeSchema = z.object({
  code: z.string().trim().min(16, "Code is required."),
});

export async function createSessionExchangeCode(
  c: AuthRouteContext,
  sessionToken: string,
  origin: string,
  challenge: string,
): Promise<string> {
  const code = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_EXCHANGE_CODE_TTL_SECONDS * 1000).toISOString();
  await c.env.DB
    .prepare(
      `INSERT INTO auth_verifications (id, identifier, value, expiresAt, createdAt, updatedAt)
       VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .bind(
      crypto.randomUUID(),
      `${SESSION_EXCHANGE_CODE_PREFIX}${code}`,
      JSON.stringify({ token: sessionToken, origin, challenge }),
      expiresAt,
    )
    .run();
  return code;
}

export async function handleSessionExchange(c: AuthRouteContext) {
  const origin = c.req.header("origin");
  if (!origin || !parseTrustedFrontendOrigins(c).includes(origin)) {
    throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "A trusted frontend origin is required.");
  }

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

  const expiresAt = verification ? Date.parse(verification.expiresAt) : Number.NaN;
  if (!verification || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new ApiError(400, "INVALID_AUTH_CODE", "Auth code is invalid or expired.");
  }

  let value: unknown;
  try {
    value = JSON.parse(verification.value);
  } catch {
    throw new ApiError(400, "INVALID_AUTH_CODE", "Auth code is invalid or expired.");
  }
  const exchange = exchangeValueSchema.safeParse(value);
  if (!exchange.success || exchange.data.origin !== origin) {
    throw new ApiError(400, "INVALID_AUTH_CODE", "Auth code is invalid or expired.");
  }

  const auth = createAuth(c.env);
  if (!await verifyOAuthExchangeProof(auth, c.req.raw.headers, exchange.data.challenge)) {
    throw new ApiError(400, "INVALID_AUTH_CODE", "Auth code does not belong to this browser login attempt.");
  }

  const consumed = await c.env.DB
    .prepare("DELETE FROM auth_verifications WHERE identifier = ?1 AND value = ?2 RETURNING id")
    .bind(identifier, verification.value)
    .first<{ id: string }>();
  if (!consumed || expiresAt <= Date.now()) {
    throw new ApiError(400, "INVALID_AUTH_CODE", "Auth code is invalid or expired.");
  }

  const session = await auth.api.getSession({
    query: { disableRefresh: true },
    headers: new Headers({
      authorization: `Bearer ${exchange.data.token}`,
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

  c.header("Set-Cookie", await serializeBrowserSessionCookie(auth, session.session), { append: true });
  c.header("Set-Cookie", expireOAuthExchangeProof(auth), { append: true });
  c.header("Cache-Control", "private, no-store");

  return c.json({
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
}
