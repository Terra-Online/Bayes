import { getCookies } from "better-auth/cookies";

import {
  buildBetterAuthRequestHeaders,
  createAuth,
  invokeBetterAuthHandler,
} from "@/lib/auth/betterAuth";
import { AUTH_EXCHANGE_CHALLENGE_PARAM } from "@/lib/auth/browserSession";
import {
  isTrustedCallbackUrlForResponse,
  toSafeTrustedUrlLog,
} from "@/lib/auth/rules/frontendOrigins";
import type { Bindings } from "@/types/app";

import type { OAuthCallbackInput } from "./types";

type SessionHandoff = {
  sessionToken: string;
  frontendUrl: URL;
  challenge: string;
};

export function invokeOAuthRequest(env: Bindings, input: OAuthCallbackInput): Promise<Response> {
  const target = new URL(input.request.url);
  const method = input.request.method.toUpperCase();
  const request = new Request(target.toString(), {
    method,
    headers: buildBetterAuthRequestHeaders(input.request),
    body: !["GET", "HEAD"].includes(method) ? input.body : undefined,
  });
  return invokeBetterAuthHandler(env, request, {
    publicPath: target.pathname,
    authPath: target.pathname.replace(/^\/auth\/v1/, ""),
    requestId: input.requestId,
  });
}

export function getProviderFromCallbackPath(path: string): string {
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

function appendQueryParam(rawUrl: string, name: string, value: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set(name, value);
  return url.toString();
}

export function inspectSessionHandoff(
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

export function attachSessionExchangeCode(
  env: Bindings,
  publicPath: string,
  better_auth_response: Response,
  frontendUrl: URL,
  code: string,
): Response {
  const location = better_auth_response.headers.get("location");
  const headers = new Headers(better_auth_response.headers);
  headers.set("location", appendQueryParam(frontendUrl.toString(), "auth_code", code));
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
