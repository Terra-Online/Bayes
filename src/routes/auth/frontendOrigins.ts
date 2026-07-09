import type { AuthRouteContext } from "./types";

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

export function readOriginFromUrl(raw: string | null): string | null {
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

export function parseTrustedFrontendOrigins(c: AuthRouteContext): string[] {
  const raw = c.env.TRUSTED_ORIGINS ?? c.env.CORS_ORIGINS;
  const backendOrigins = new Set(
    [DEFAULT_AUTH_ORIGIN, readOriginFromUrl(c.env.BETTER_AUTH_URL ?? null)].filter(
      (origin): origin is string => origin !== null,
    ),
  );

  if (!raw || raw.trim().length === 0) {
    return isLocalBackendUrl(c.env.BETTER_AUTH_URL)
      ? LOCAL_TRUSTED_FRONTEND_ORIGINS
      : DEFAULT_TRUSTED_FRONTEND_ORIGINS;
  }

  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !backendOrigins.has(item));

  return parsed.length > 0 ? parsed : DEFAULT_TRUSTED_FRONTEND_ORIGINS;
}

export function resolveTrustedRequestOrigin(c: AuthRouteContext): string | null {
  const trustedOrigins = parseTrustedFrontendOrigins(c);
  const candidates = [
    c.req.header("origin")?.trim() || null,
    readOriginFromUrl(c.req.header("referer") ?? null),
  ];

  return candidates.find((origin) => origin !== null && trustedOrigins.includes(origin)) ?? null;
}

export function resolveTrustedCallbackUrl(
  c: AuthRouteContext,
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
    return parseTrustedFrontendOrigins(c).includes(url.origin) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function isTrustedCallbackUrlForResponse(c: AuthRouteContext, raw: string): boolean {
  try {
    const url = new URL(raw);
    return parseTrustedFrontendOrigins(c).includes(url.origin);
  } catch {
    return false;
  }
}
