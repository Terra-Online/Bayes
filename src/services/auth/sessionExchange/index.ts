// To avoid confusion between Hono's request and Better Auth's inputs and outputs,
// we use explicit data for this module's interface. HTTP objects stay inside this module.

import { z } from "zod";

import { ApiError } from "@/lib/errors";
import { readSessionUser, formatPublicUid } from "@/repositories/users";
import { createAuth } from "@/services/auth/betterAuth";
import {
  expireOAuthExchangeProof,
  inspectOAuthExchangeProof,
  serializeBrowserSessionCookie,
} from "@/services/auth/browserSession";
import type { Bindings } from "@/types/app";

import { consumeExchange, findExchange, storeExchange } from "./exchangeRepository";
import type {
  CreateSessionExchangeCodeInput,
  ExchangeSessionInput,
  ExchangeSessionResult,
} from "./types";

export type {
  CreateSessionExchangeCodeInput,
  ExchangeSessionInput,
  ExchangeSessionResult,
} from "./types";

const CODE_TTL_SECONDS = 120;
const exchangeValueSchema = z.object({
  token: z.string().min(1),
  origin: z.string().url(),
  challenge: z.string().regex(/^[a-f0-9]{64}$/),
});

function classifyBrowser(
  userAgent: string | undefined,
): "firefox" | "chromium" | "safari" | "other" {
  if (!userAgent) {
    return "other";
  }
  if (/firefox\//i.test(userAgent)) {
    return "firefox";
  }
  if (/(?:chrome|chromium|crios)\//i.test(userAgent)) {
    return "chromium";
  }
  if (/safari\//i.test(userAgent)) {
    return "safari";
  }
  return "other";
}

function logExchangeFailure(
  input: ExchangeSessionInput,
  phase: "code_lookup" | "proof_missing" | "proof_mismatch" | "session_lookup" | "consume_conflict",
): void {
  console.error("[auth][session-exchange] rejected", {
    requestId: input.requestId,
    phase,
    origin: input.origin,
    browser: classifyBrowser(input.userAgent),
    hasCookieHeader: Boolean(input.cookie),
  });
}

export async function createSessionExchangeCode(
  db: D1Database,
  input: CreateSessionExchangeCodeInput,
): Promise<string> {
  const code = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString();
  await storeExchange(
    db,
    code,
    {
      token: input.sessionToken,
      origin: input.origin,
      challenge: input.challenge,
    },
    expiresAt,
  );
  return code;
}

export async function exchangeSession(
  env: Bindings,
  input: ExchangeSessionInput,
): Promise<ExchangeSessionResult> {
  const verification = await findExchange(env.DB, input.code);
  const expiresAt = verification ? Date.parse(verification.expiresAt) : Number.NaN;
  if (!verification || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    logExchangeFailure(input, "code_lookup");
    throw new ApiError(400, "INVALID_AUTH_CODE", "Auth code is invalid or expired.");
  }

  let value: unknown;
  try {
    value = JSON.parse(verification.value);
  } catch {
    throw new ApiError(400, "INVALID_AUTH_CODE", "Auth code is invalid or expired.");
  }
  const exchange = exchangeValueSchema.safeParse(value);
  if (!exchange.success || exchange.data.origin !== input.origin) {
    throw new ApiError(400, "INVALID_AUTH_CODE", "Auth code is invalid or expired.");
  }

  const auth = createAuth(env);
  // Better Auth's cookie helpers read the browser proof from a Cookie header.
  const proof_headers = new Headers();
  if (input.cookie !== undefined) {
    proof_headers.set("cookie", input.cookie);
  }
  const proofResult = await inspectOAuthExchangeProof(auth, proof_headers, exchange.data.challenge);
  if (proofResult !== "valid") {
    logExchangeFailure(input, proofResult === "missing" ? "proof_missing" : "proof_mismatch");
    throw new ApiError(
      400,
      "INVALID_AUTH_CODE",
      "Auth code does not belong to this browser login attempt.",
    );
  }

  // Use the OAuth callback's session token. Incoming credentials are not used here.
  const session = await auth.api.getSession({
    query: { disableRefresh: true },
    headers: new Headers({ authorization: `Bearer ${exchange.data.token}` }),
  });
  if (!session) {
    logExchangeFailure(input, "session_lookup");
    throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
  }

  // Validate the browser and session before consuming the code, so failed checks allow retry.
  const consumed = await consumeExchange(env.DB, input.code, verification.value);
  if (!consumed || expiresAt <= Date.now()) {
    logExchangeFailure(input, "consume_conflict");
    throw new ApiError(400, "INVALID_AUTH_CODE", "Auth code is invalid or expired.");
  }

  const profile = await readSessionUser(env.DB, session.user.id);
  const cookies = [
    await serializeBrowserSessionCookie(auth, session.session),
    expireOAuthExchangeProof(auth),
  ];
  return {
    user: {
      uid: profile.uid,
      publicUid: formatPublicUid(profile.uidNumber, profile.uidSuffix),
      role: profile.role,
      karma: profile.karma,
      avatar: profile.avt,
      email: profile.email,
      nickname: profile.nickname,
      registeredAt: profile.createdAt,
      needsProfileSetup: !profile.nicknameConfirmed,
    },
    cookies,
  };
}
