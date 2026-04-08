import type { Bindings } from "../types/app";

export interface RuntimeConfig {
  sessionTtlSeconds: number;
  progressCacheTtlSeconds: number;
  uploadUrlTtlSeconds: number;
  allowedUploadMime: Set<string>;
  maxUploadBytes: number;
}

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_PROGRESS_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_UPLOAD_URL_TTL_SECONDS = 15 * 60;
const DEFAULT_MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function getRuntimeConfig(env: Bindings): RuntimeConfig {
  const allowed = (env.ALLOWED_UPLOAD_MIME ?? "image/jpeg,image/png,image/webp")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return {
    sessionTtlSeconds: parsePositiveInt(env.SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS),
    progressCacheTtlSeconds: parsePositiveInt(env.PROGRESS_CACHE_TTL_SECONDS, DEFAULT_PROGRESS_TTL_SECONDS),
    uploadUrlTtlSeconds: parsePositiveInt(env.UPLOAD_URL_TTL_SECONDS, DEFAULT_UPLOAD_URL_TTL_SECONDS),
    allowedUploadMime: new Set(allowed),
    maxUploadBytes: parsePositiveInt(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES)
  };
}
