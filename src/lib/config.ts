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
  googleTranslate: {
    clientEmail?: string;
    privateKey?: string;
    projectId?: string;
    location: string;
    glossary?: string;
    glossaryVersion: string;
    glossaryLanguages: Set<string>;
    allowedLanguages: Set<string>;
    fetchProxyUrl?: string;
  };
}

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_PROGRESS_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_UPLOAD_URL_TTL_SECONDS = 15 * 60;
const DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const DEFAULT_UGC_ASSET_BASE_URL = "https://assets.opendfieldmap.org";
const DEFAULT_TEST_UPLOAD_PREFIX = "_test";
const DEFAULT_SURGE_BACKOFF_MULTIPLIER = 3;
const DEFAULT_GOOGLE_TRANSLATE_LOCATION = "global";
const DEFAULT_GOOGLE_TRANSLATE_GLOSSARY_VERSION = "g2026-07-01";
const DEFAULT_GOOGLE_TRANSLATE_GLOSSARY_LANGUAGES = [
  "zh-CN",
  "zh-HK",
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
  "pt-BR",
  "ru",
  "th",
  "vi",
  "id",
  "ms"
];
const DEFAULT_GOOGLE_TRANSLATE_ALLOWED_LANGUAGES = [
  ...DEFAULT_GOOGLE_TRANSLATE_GLOSSARY_LANGUAGES,
  "pl",
  "sv",
  "it",
  "ar",
  "hi",
  "el"
];

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

function parseCsvSet(value: string | undefined, fallback: string[]): Set<string> {
  const parsed = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return new Set(parsed.length > 0 ? parsed : fallback);
}

function normalizeCacheVersion(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const prefixed = trimmed.startsWith("g") ? trimmed : `g${trimmed}`;
  return prefixed.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 64) || fallback;
}

function normalizeLocalProxyUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizePrivateKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\\n/g, "\n");
}

export function getRuntimeConfig(env: Bindings): RuntimeConfig {
  const allowed = (env.ALLOWED_UPLOAD_MIME ?? "image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif")
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
    scheduledModerationEnabled: parseBoolean(env.ENABLE_SCHEDULED_MODERATION, true),
    surgeModeEnabled: parseBoolean(env.SURGE_MODE_ENABLED, false),
    surgeBackoffMultiplier: parsePositiveInt(env.SURGE_BACKOFF_MULTIPLIER, DEFAULT_SURGE_BACKOFF_MULTIPLIER),
    googleTranslate: {
      clientEmail: env.GOOGLE_TRANSLATE_CLIENT_EMAIL?.trim() || undefined,
      privateKey: normalizePrivateKey(env.GOOGLE_TRANSLATE_PRIVATE_KEY),
      projectId: env.GOOGLE_TRANSLATE_PROJECT_ID?.trim() || undefined,
      location: env.GOOGLE_TRANSLATE_LOCATION?.trim() || DEFAULT_GOOGLE_TRANSLATE_LOCATION,
      glossary: env.GOOGLE_TRANSLATE_GLOSSARY?.trim() || undefined,
      glossaryVersion: normalizeCacheVersion(
        env.GOOGLE_TRANSLATE_GLOSSARY_VERSION,
        DEFAULT_GOOGLE_TRANSLATE_GLOSSARY_VERSION
      ),
      glossaryLanguages: parseCsvSet(
        env.GOOGLE_TRANSLATE_GLOSSARY_LANGUAGES,
        DEFAULT_GOOGLE_TRANSLATE_GLOSSARY_LANGUAGES
      ),
      allowedLanguages: parseCsvSet(env.GOOGLE_TRANSLATE_ALLOWED_LANGUAGES, DEFAULT_GOOGLE_TRANSLATE_ALLOWED_LANGUAGES),
      fetchProxyUrl: normalizeLocalProxyUrl(env.GOOGLE_TRANSLATE_FETCH_PROXY_URL)
    }
  };
}
