import type { Bindings } from "@/types/app";

export type FrontendOriginSettings = Pick<
  Bindings,
  "TRUSTED_ORIGINS" | "CORS_ORIGINS" | "BETTER_AUTH_URL"
>;

type RequestOriginInfo = { origin?: string; referer?: string };

export type SocialCallbackUrls = {
  callbackURL: string;
  newUserCallbackURL: string;
  errorCallbackURL: string;
};

const DEFAULT_TRUSTED_FRONTEND_ORIGINS = [
  "https://opendfieldmap.org",
  "https://www.opendfieldmap.org",
  "https://beta.opendfieldmap.org",
  "https://opendfieldmap.cn",
  "https://www.opendfieldmap.cn",
  "https://beta.opendfieldmap.cn",
];

const LOCAL_TRUSTED_FRONTEND_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5429",
  "http://127.0.0.1:5429",
];

const DEFAULT_AUTH_ORIGIN = "https://api.opendfieldmap.org";
const CN_AUTH_ORIGIN = "https://api.opendfieldmap.cn";

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

export function parseTrustedFrontendOrigins(env: FrontendOriginSettings): string[] {
  const raw = env.TRUSTED_ORIGINS ?? env.CORS_ORIGINS;
  const backendOrigins = new Set(
    [DEFAULT_AUTH_ORIGIN, CN_AUTH_ORIGIN, readOriginFromUrl(env.BETTER_AUTH_URL ?? null)].filter(
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

export function resolveTrustedRequestOrigin(
  env: FrontendOriginSettings,
  request: RequestOriginInfo,
): string | null {
  const trustedOrigins = parseTrustedFrontendOrigins(env);
  const candidates = [request.origin?.trim() || null, readOriginFromUrl(request.referer ?? null)];

  return candidates.find((origin) => origin !== null && trustedOrigins.includes(origin)) ?? null;
}

function resolveTrustedCallbackUrl(
  env: FrontendOriginSettings,
  raw: string | undefined,
  baseOrigin: string,
): string | null {
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  const value = raw.trim();
  if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")) {
    return new URL(value, baseOrigin).toString();
  }

  try {
    const url = new URL(value);
    return parseTrustedFrontendOrigins(env).includes(url.origin) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function isTrustedCallbackUrlForResponse(env: FrontendOriginSettings, raw: string): boolean {
  try {
    const url = new URL(raw);
    return parseTrustedFrontendOrigins(env).includes(url.origin);
  } catch {
    return false;
  }
}

export function applyDefaultSocialCallbackUrls(
  env: FrontendOriginSettings,
  request: RequestOriginInfo,
  input: Partial<SocialCallbackUrls>,
): SocialCallbackUrls | null {
  const defaultOrigin = resolveTrustedRequestOrigin(env, request);
  // Without a trusted request origin, callers keep their original callback fields.
  if (!defaultOrigin) {
    return null;
  }

  const callbackURL =
    resolveTrustedCallbackUrl(env, input.callbackURL, defaultOrigin) ?? defaultOrigin;
  return {
    callbackURL,
    newUserCallbackURL:
      resolveTrustedCallbackUrl(env, input.newUserCallbackURL, defaultOrigin) ?? callbackURL,
    errorCallbackURL:
      resolveTrustedCallbackUrl(env, input.errorCallbackURL, defaultOrigin) ?? callbackURL,
  };
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

export function toSafeTrustedUrlLog(env: FrontendOriginSettings, raw: string | null) {
  const details = toSafeUrlLog(raw);
  if (!raw) {
    return details;
  }

  return {
    ...details,
    trusted: isTrustedCallbackUrlForResponse(env, raw),
  };
}
