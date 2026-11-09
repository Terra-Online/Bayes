import { getCookies } from "better-auth/cookies";

import { createAuth, invokeBetterAuthHandler } from "@/services/auth/betterAuth";
import { AUTH_EXCHANGE_CHALLENGE_PARAM } from "@/services/auth/browserSession";
import {
  isTrustedCallbackUrlForResponse,
  toSafeTrustedUrlLog,
} from "@/services/auth/rules/frontendOrigins";
import { createSessionExchangeCode } from "@/services/auth/sessionExchange";
import type { Bindings } from "@/types/app";

export type OAuthCallbackInput = {
  // The HTTP entrypoint must leave this body unread. Better Auth consumes its stream.
  raw_request: Request;
  requestId: string;
};

export async function completeOAuthCallback(
  env: Bindings,
  input: OAuthCallbackInput,
): Promise<Response> {
  const url = new URL(input.raw_request.url);
  const provider = getProviderFromCallbackPath(url.pathname);
  console.warn("[auth][oauth-callback] incoming", {
    provider,
    method: input.raw_request.method,
    hasState: Boolean(url.searchParams.get("state")),
    hasCode: Boolean(url.searchParams.get("code")),
    hasError: Boolean(url.searchParams.get("error")),
  });
  const response = await invokeBetterAuthHandler(env, input.raw_request, {
    requestId: input.requestId,
  });
  const location = response.headers.get("location");
  console.warn("[auth][oauth-callback] response", {
    provider,
    status: response.status,
    hasLocation: Boolean(location),
    location: toSafeTrustedUrlLog(env, location),
    hasSetCookie: Boolean(response.headers.get("set-cookie")),
    hasSetAuthToken: Boolean(response.headers.get("set-auth-token")),
  });
  // Better Auth validates state and completes login or binding before returning this response.
  const handoff = inspectSessionHandoff(env, url.pathname, response);
  if (!handoff) {
    return response;
  }
  const code = await createSessionExchangeCode(env.DB, {
    sessionToken: handoff.sessionToken,
    origin: handoff.frontendUrl.origin,
    challenge: handoff.challenge,
  });
  return attachSessionExchangeCode(env, url.pathname, response, handoff.frontendUrl, code);
}

export function handleOAuthError(env: Bindings, input: OAuthCallbackInput): Promise<Response> {
  return invokeBetterAuthHandler(env, input.raw_request, { requestId: input.requestId });
}

type SessionHandoff = {
  sessionToken: string;
  frontendUrl: URL;
  challenge: string;
};

function getProviderFromCallbackPath(path: string): string {
  return path.split("/").pop() || "unknown";
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
        cursor < setCookie.length &&
        setCookie[cursor] !== "=" &&
        setCookie[cursor] !== ";" &&
        setCookie[cursor] !== ","
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

function readSessionTokenFromSetCookie(
  setCookie: string | null,
  cookieName: string,
): string | null {
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
    if (name !== cookieName) {
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

function readSessionTokenFromResponse(
  env: Bindings,
  better_auth_response: Response,
): string | null {
  const authToken = better_auth_response.headers.get("set-auth-token")?.trim();
  if (authToken) {
    return authToken;
  }

  const cookieName = getCookies(createAuth(env).options).sessionToken.name;
  return readSessionTokenFromSetCookie(better_auth_response.headers.get("set-cookie"), cookieName);
}

function inspectSessionHandoff(
  env: Bindings,
  publicPath: string,
  better_auth_response: Response,
): SessionHandoff | null {
  if (!better_auth_response.status.toString().startsWith("3")) {
    return null;
  }

  const location = better_auth_response.headers.get("location");
  if (!location || !isTrustedCallbackUrlForResponse(env, location)) {
    console.warn("[auth][oauth-callback] skipped session exchange code", {
      provider: getProviderFromCallbackPath(publicPath),
      status: better_auth_response.status,
      hasLocation: Boolean(location),
      location: toSafeTrustedUrlLog(env, location),
      hasSetCookie: Boolean(better_auth_response.headers.get("set-cookie")),
      hasSetAuthToken: Boolean(better_auth_response.headers.get("set-auth-token")),
    });
    return null;
  }

  const sessionToken = readSessionTokenFromResponse(env, better_auth_response);
  if (!sessionToken) {
    console.warn("[auth][oauth-callback] missing session token for exchange code", {
      provider: getProviderFromCallbackPath(publicPath),
      status: better_auth_response.status,
      hasLocation: Boolean(location),
      location: toSafeTrustedUrlLog(env, location),
      hasSetCookie: Boolean(better_auth_response.headers.get("set-cookie")),
      hasSetAuthToken: Boolean(better_auth_response.headers.get("set-auth-token")),
    });
    return null;
  }

  const frontendUrl = new URL(location);
  const challenge = frontendUrl.searchParams.get(AUTH_EXCHANGE_CHALLENGE_PARAM);
  if (!challenge || !/^[a-f0-9]{64}$/.test(challenge)) {
    return null;
  }
  frontendUrl.searchParams.delete(AUTH_EXCHANGE_CHALLENGE_PARAM);
  return { sessionToken, frontendUrl, challenge };
}

function attachSessionExchangeCode(
  env: Bindings,
  publicPath: string,
  better_auth_response: Response,
  owned_frontend_url: URL,
  code: string,
): Response {
  const location = better_auth_response.headers.get("location");
  const headers = new Headers(better_auth_response.headers);
  // The handoff transfers this URL. Patch it in place without serializing and reparsing it.
  owned_frontend_url.searchParams.set("auth_code", code);
  headers.set("location", owned_frontend_url.toString());
  headers.set("Cache-Control", "private, no-store");
  headers.set("Referrer-Policy", "no-referrer");
  console.warn("[auth][oauth-callback] attached session exchange code", {
    provider: getProviderFromCallbackPath(publicPath),
    status: better_auth_response.status,
    location: toSafeTrustedUrlLog(env, location),
    hasSetCookie: Boolean(better_auth_response.headers.get("set-cookie")),
    hasSetAuthToken: Boolean(better_auth_response.headers.get("set-auth-token")),
  });
  return new Response(better_auth_response.body, {
    status: better_auth_response.status,
    statusText: better_auth_response.statusText,
    headers,
  });
}
