import { createCookieGetter, getCookies, parseCookies } from "better-auth/cookies";
import { makeSignature } from "better-auth/crypto";
import { generateCookie } from "hono/cookie";
import { ApiError } from "../errors";
import type { createAuth } from "./createAuth";

type Auth = ReturnType<typeof createAuth>;
export const AUTH_EXCHANGE_CHALLENGE_PARAM = "auth_exchange_challenge";

function getExchangeProofCookie(auth: Auth) {
  return createCookieGetter(auth.options)("oauth_exchange_proof", { maxAge: 600 });
}

async function hashProof(proof: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createOAuthExchangeProof(auth: Auth): Promise<{ challenge: string; cookie: string }> {
  const proof = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const cookie = getExchangeProofCookie(auth);
  return { challenge: await hashProof(proof), cookie: generateCookie(cookie.name, proof, cookie.attributes) };
}

export async function verifyOAuthExchangeProof(auth: Auth, headers: Headers, challenge: string): Promise<boolean> {
  const cookie = getExchangeProofCookie(auth);
  const cookies = parseCookies((headers.get("cookie") ?? "").split(";").map((value) => value.trim()).join("; "));
  const proof = cookies.get(cookie.name);
  return Boolean(proof && proof.length <= 128 && await hashProof(proof) === challenge);
}

export function expireOAuthExchangeProof(auth: Auth): string {
  const cookie = getExchangeProofCookie(auth);
  return generateCookie(cookie.name, "", { ...cookie.attributes, maxAge: 0 });
}

function getLegacyCookies(auth: Auth) {
  return getCookies({
    ...auth.options,
    advanced: { ...auth.options.advanced, cookiePrefix: "better-auth" },
  });
}

export function resolveBrowserSessionHeaders(auth: Auth, headers: Headers): { headers: Headers; migrating: boolean } {
  const currentName = getCookies(auth.options).sessionToken.name;
  const legacyName = getLegacyCookies(auth).sessionToken.name;
  const cookies = parseCookies((headers.get("cookie") ?? "").split(";").map((cookie) => cookie.trim()).join("; "));
  if (currentName === legacyName || headers.has("authorization") || cookies.has(currentName)) {
    return { headers, migrating: false };
  }
  const legacyToken = cookies.get(legacyName);
  if (!legacyToken?.includes(".")) return { headers, migrating: false };

  const migratedHeaders = new Headers(headers);
  migratedHeaders.set("cookie", `${headers.get("cookie")}; ${currentName}=${legacyToken}`);
  return { headers: migratedHeaders, migrating: true };
}

export async function serializeBrowserSessionCookie(auth: Auth, session: { token: string; expiresAt: Date }): Promise<string> {
  const cookie = getCookies(auth.options).sessionToken;
  const maxAge = Math.floor((session.expiresAt.getTime() - Date.now()) / 1000);
  if (maxAge <= 0) throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
  const signature = await makeSignature(session.token, (await auth.$context).secret);
  return generateCookie(cookie.name, `${session.token}.${signature}`, { ...cookie.attributes, maxAge });
}

export function getLegacyCookieExpirations(auth: Auth): string[] {
  const legacyCookies = getLegacyCookies(auth);
  if (legacyCookies.sessionToken.name === getCookies(auth.options).sessionToken.name) return [];
  return Object.values(legacyCookies).map((cookie) => generateCookie(cookie.name, "", {
    ...cookie.attributes,
    partitioned: false,
    maxAge: 0,
  }));
}
