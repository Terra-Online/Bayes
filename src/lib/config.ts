import type { Bindings } from "../types/app";

export interface RuntimeConfig {
  sessionTtlSeconds: number;
  progressCacheTtlSeconds: number;
  uploadUrlTtlSeconds: number;
  allowedUploadMime: Set<string>;
  maxUploadBytes: number;
  ugcAssetBaseUrl: string;
  ugcUploadPathPrefix: string;
  skipAiModeration: boolean;
  localUploadAutoApprove: boolean;
  scheduledModerationEnabled: boolean;
  surgeModeEnabled: boolean;
  surgeBackoffMultiplier: number;
}

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_PROGRESS_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_UPLOAD_URL_TTL_SECONDS = 15 * 60;
const DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const DEFAULT_UGC_ASSET_BASE_URL = "https://assets.opendfieldmap.org";
const DEFAULT_TEST_UPLOAD_PREFIX = "_test";
const DEFAULT_SURGE_BACKOFF_MULTIPLIER = 3;

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

function normalizeUploadPrefix(raw: string | undefined): string {
  return (raw ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9_/-]/g, "-")
    .replace(/\/+/g, "/")
    .replace(/\.\./g, "")
    .slice(0, 96);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "off", "no"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export function getRuntimeConfig(env: Bindings): RuntimeConfig {
  const allowed = (env.ALLOWED_UPLOAD_MIME ?? "image/jpeg,image/png,image/webp,image/avif")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const localAutoApprove = (env.LOCAL_UPLOAD_AUTO_APPROVE ?? "")
    .trim()
    .toLowerCase();

  return {
    sessionTtlSeconds: parsePositiveInt(env.SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS),
    progressCacheTtlSeconds: parsePositiveInt(env.PROGRESS_CACHE_TTL_SECONDS, DEFAULT_PROGRESS_TTL_SECONDS),
    uploadUrlTtlSeconds: parsePositiveInt(env.UPLOAD_URL_TTL_SECONDS, DEFAULT_UPLOAD_URL_TTL_SECONDS),
    allowedUploadMime: new Set(allowed),
    maxUploadBytes: parsePositiveInt(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES),
    ugcAssetBaseUrl: (env.UGC_ASSET_BASE_URL ?? DEFAULT_UGC_ASSET_BASE_URL).replace(/\/$/, ""),
    ugcUploadPathPrefix: normalizeUploadPrefix(
      env.UGC_UPLOAD_TEST_PREFIX ?? (isLocalBackendUrl(env.BETTER_AUTH_URL) ? DEFAULT_TEST_UPLOAD_PREFIX : "")
    ),
    skipAiModeration: parseBoolean(env.SKIP_AI_MODERATION, false),
    localUploadAutoApprove: ["1", "true", "on", "yes"].includes(localAutoApprove),
    scheduledModerationEnabled: parseBoolean(env.ENABLE_SCHEDULED_MODERATION, false),
    surgeModeEnabled: parseBoolean(env.SURGE_MODE_ENABLED, false),
    surgeBackoffMultiplier: parsePositiveInt(env.SURGE_BACKOFF_MULTIPLIER, DEFAULT_SURGE_BACKOFF_MULTIPLIER)
  };
}
