import { getCookies } from "better-auth/cookies";
import { createAuth } from "../../lib/auth/createAuth";
import { AUTH_EXCHANGE_CHALLENGE_PARAM } from "../../lib/auth/browserSession";
import { createSessionExchangeCode } from "./sessionExchange";
import {
  isTrustedCallbackUrlForResponse,
  resolveTrustedCallbackUrl,
  resolveTrustedRequestOrigin,
} from "./frontendOrigins";
import type { AuthRouteContext } from "./types";

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

function readSessionTokenFromSetCookie(setCookie: string | null, cookieName: string): string | null {
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

function readSessionTokenFromResponse(c: AuthRouteContext, response: Response): string | null {
  const authToken = response.headers.get("set-auth-token")?.trim();
  if (authToken) {
    return authToken;
  }

  const cookieName = getCookies(createAuth(c.env).options).sessionToken.name;
  return readSessionTokenFromSetCookie(response.headers.get("set-cookie"), cookieName);
}

function appendQueryParam(rawUrl: string, name: string, value: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set(name, value);
  return url.toString();
}

export function getProviderFromCallbackPath(path: string): string {
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

export function toSafeTrustedUrlLog(c: AuthRouteContext, raw: string | null) {
  const details = toSafeUrlLog(raw);
  if (!raw) {
    return details;
  }

  return {
    ...details,
    trusted: isTrustedCallbackUrlForResponse(c, raw),
  };
}

export function applyDefaultSocialCallbackUrls(c: AuthRouteContext, body: Record<string, unknown>) {
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

export async function attachSessionExchangeCode(c: AuthRouteContext, response: Response): Promise<Response> {
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

  const sessionToken = readSessionTokenFromResponse(c, response);
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

  const frontendUrl = new URL(location);
  const challenge = frontendUrl.searchParams.get(AUTH_EXCHANGE_CHALLENGE_PARAM);
  if (!challenge || !/^[a-f0-9]{64}$/.test(challenge)) return response;
  frontendUrl.searchParams.delete(AUTH_EXCHANGE_CHALLENGE_PARAM);
  const code = await createSessionExchangeCode(c, sessionToken, frontendUrl.origin, challenge);
  const headers = new Headers(response.headers);
  headers.set("location", appendQueryParam(frontendUrl.toString(), "auth_code", code));
  headers.set("Cache-Control", "private, no-store");
  headers.set("Referrer-Policy", "no-referrer");
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
