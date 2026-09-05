import type { Bindings } from "../../types/app";
import { readEnv } from "../utils";

const DEFAULT_TRUSTED_ORIGINS = [
  "https://opendfieldmap.org",
  "https://www.opendfieldmap.org",
  "https://beta.opendfieldmap.org",
  "https://opendfieldmap.cn",
  "https://www.opendfieldmap.cn",
  "https://api.opendfieldmap.org",
];

const LOCAL_TRUSTED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
];

export const DEFAULT_AUTH_BASE_URL = "https://api.opendfieldmap.org";
export const PARTITIONED_AUTH_COOKIE_PREFIX = "oem-chips";

export function isLocalBaseUrl(raw: string | undefined): boolean {
  const normalized = readEnv(raw);
  if (!normalized) {
    return false;
  }

  try {
    const url = new URL(normalized);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export function parseAuthTrustedOrigins(env: Bindings): string[] {
  const normalized = readEnv(env.TRUSTED_ORIGINS ?? env.CORS_ORIGINS);
  if (!normalized) {
    return isLocalBaseUrl(env.BETTER_AUTH_URL) ? LOCAL_TRUSTED_ORIGINS : DEFAULT_TRUSTED_ORIGINS;
  }

  const parsed = normalized
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return parsed.length > 0 ? parsed : DEFAULT_TRUSTED_ORIGINS;
}

export function resolveCookieAttributes(baseUrl: string | undefined):
  | { sameSite: "none"; secure: true; httpOnly: true; partitioned: true }
  | undefined {
  if (isLocalBaseUrl(baseUrl)) {
    return undefined;
  }

  return {
    sameSite: "none",
    secure: true,
    httpOnly: true,
    partitioned: true,
  };
}
