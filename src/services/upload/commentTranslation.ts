import { getRuntimeConfig, type RuntimeConfig } from "../../lib/config";
import { getJsonFromKv, putJsonToKv, sha256Hex } from "../../middleware/cache/kvJson";
import { getVisibleCommentsByIds } from "../../repositories/submission/statusSubmission";
import {
  getTextTranslation,
  getTextTranslationByTarget,
  upsertTextTranslation
} from "../../repositories/submission/textTranslationCache";
import type { SubmissionRecord, TextTranslationRecord } from "../../repositories/submission/types";
import type { Bindings } from "../../types/app";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_TRANSLATION_SCOPE = "https://www.googleapis.com/auth/cloud-translation";
const GOOGLE_TRANSLATION_PROVIDER = "google_cloud_translation_v3";
const GOOGLE_TRANSLATION_CACHE_PROVIDER = "google-v3";
const GOOGLE_ACCESS_TOKEN_SKEW_SECONDS = 60;
const GOOGLE_FETCH_TIMEOUT_MS = 15_000;
const MAX_TRANSLATION_BATCH_SIZE = 100;
const TRANSLATION_KV_CACHE_PREFIX = "translate:v1";
const TRANSLATION_NO_GLOSSARY_CACHE_VERSION = "g0";
const APPROVED_COMMENT_PREWARM_TARGET_LANGUAGES = ["en-US", "ru-RU", "ja-JP", "ko-KR"] as const;
const GOOGLE_LANGUAGE_BY_LOCALE: Record<string, string> = {
  "en-US": "en",
  "zh-CN": "zh-CN",
  "zh-HK": "zh-TW",
  "zh-TW": "zh-TW",
  "ja-JP": "ja",
  "ko-KR": "ko",
  "ru-RU": "ru",
  "es-ES": "es",
  "fr-FR": "fr",
  "de-DE": "de",
  "it-IT": "it",
  "pt-BR": "pt",
  "id-ID": "id",
  "ar-SA": "ar",
  "ms-MY": "ms",
  "pl-PL": "pl",
  "sv-SE": "sv",
  "th-TH": "th",
  "vi-VN": "vi",
  "el-GR": "el",
  "hi-IN": "hi",
  "uk-UA": "uk",
  "tr-TR": "tr"
};
const GOOGLE_LANGUAGE_BY_LOWERCASE_LOCALE = Object.fromEntries(
  Object.entries(GOOGLE_LANGUAGE_BY_LOCALE).map(([locale, language]) => [locale.toLowerCase(), language])
);

type CachedGoogleAccessToken = {
  token: string;
  expiresAt: number;
};

type GoogleTranslateResponse = {
  translations?: Array<{
    translatedText?: string;
    detectedLanguageCode?: string;
    glossaryConfig?: unknown;
  }>;
  glossaryTranslations?: Array<{
    translatedText?: string;
    detectedLanguageCode?: string;
    glossaryConfig?: unknown;
  }>;
};

type GoogleFetchProxyResponse = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
};

export type CommentTranslationItem = {
  commentId: string;
  translatedContent?: string;
  sourceLanguage?: string;
  targetLanguage: string;
  provider: string;
  glossaryApplied: boolean;
  cached: boolean;
  error?: string;
};

type TextTranslationCacheRecord = {
  translatedText: string;
  sourceLanguage: string;
  detectedSourceLanguage?: string;
  targetLanguage: string;
  provider: string;
  glossaryApplied: boolean;
  glossaryKey: string;
  glossaryVersion: string;
  flowVersion: string;
  translatedAt: string;
};

type TextTranslationCacheDescriptor = {
  cacheKey: string;
  textHash: string;
  flowVersion: string;
  sourceLanguage: string;
  targetLanguage: string;
  glossaryVersion: string;
  glossaryKey: string;
};

type TextTranslationTargetDescriptor = {
  detectionCacheKey: string;
  textHash: string;
  targetLanguage: string;
  glossaryVersion: string;
  glossaryKey: string;
};

type TextTranslationDetectionCacheRecord = {
  sourceLanguage: string;
  cacheKey: string;
  textHash: string;
  targetLanguage: string;
  provider: string;
  glossaryVersion: string;
  glossaryKey: string;
  createdAt: string;
};

let cachedGoogleAccessToken: CachedGoogleAccessToken | null = null;

function base64UrlEncode(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : new Uint8Array(input);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function parsePemPrivateKey(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    parsePemPrivateKey(pem),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );
}

async function createGoogleJwt(config: RuntimeConfig["googleTranslate"]): Promise<string> {
  if (!config.clientEmail || !config.privateKey) {
    throw new Error("Google Translation service account is not configured.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT"
  };
  const claim = {
    iss: config.clientEmail,
    scope: GOOGLE_TRANSLATION_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claim))}`;
  const key = await importPrivateKey(config.privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

async function getGoogleAccessToken(config: RuntimeConfig["googleTranslate"]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedGoogleAccessToken && cachedGoogleAccessToken.expiresAt - GOOGLE_ACCESS_TOKEN_SKEW_SECONDS > now) {
    return cachedGoogleAccessToken.token;
  }

  const assertion = await createGoogleJwt(config);
  const response = await fetchWithTimeout(
    "google-token",
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion
      })
    },
    config.fetchProxyUrl
  );

  if (!response.ok) {
    throw new Error(`Google token request failed (${response.status}).`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token) {
    throw new Error("Google token response did not include access_token.");
  }

  cachedGoogleAccessToken = {
    token: payload.access_token,
    expiresAt: now + Math.max(60, Number(payload.expires_in ?? 3600))
  };
  return payload.access_token;
}

function serializeFetchBody(body: RequestInit["body"]): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return undefined;
}

function serializeFetchHeaders(headers: RequestInit["headers"]): Record<string, string> {
  const serialized: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    serialized[key] = value;
  });
  return serialized;
}

async function fetchThroughLocalProxy(
  proxyUrl: string,
  input: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  const proxyResponse = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url: input,
      method: init.method ?? "GET",
      headers: serializeFetchHeaders(init.headers),
      body: serializeFetchBody(init.body)
    }),
    signal
  });
  if (!proxyResponse.ok) {
    throw new Error(`Google local fetch proxy failed (${proxyResponse.status}).`);
  }

  const payload = (await proxyResponse.json()) as GoogleFetchProxyResponse;
  return new Response(payload.body ?? "", {
    status: payload.status ?? 502,
    headers: payload.headers
  });
}

async function fetchWithTimeout(
  label: string,
  input: string,
  init: RequestInit,
  proxyUrl?: string,
  timeoutMs = GOOGLE_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Google Translation request timed out."), timeoutMs);
  try {
    return proxyUrl
      ? await fetchThroughLocalProxy(proxyUrl, input, init, controller.signal)
      : await fetch(input, {
          ...init,
          signal: controller.signal
        });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Google Translation ${label} request timed out.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function toGoogleLanguageCode(language: string): string {
  const trimmed = language.trim();
  return GOOGLE_LANGUAGE_BY_LOCALE[trimmed]
    ?? GOOGLE_LANGUAGE_BY_LOWERCASE_LOCALE[trimmed.toLowerCase()]
    ?? trimmed;
}

function toTranslationCacheLanguage(language: string): string {
  return toGoogleLanguageCode(language).trim();
}

function hasGoogleLanguage(languages: Set<string>, language: string): boolean {
  const googleLanguage = toGoogleLanguageCode(language);
  for (const configuredLanguage of languages) {
    if (toGoogleLanguageCode(configuredLanguage) === googleLanguage) {
      return true;
    }
  }
  return false;
}

function normalizeTextForTranslationCache(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ");
}

function validateLanguage(config: RuntimeConfig["googleTranslate"], language: string): boolean {
  const trimmed = language.trim();
  if (!trimmed) {
    return false;
  }
  if (config.allowedLanguages.has(trimmed)) {
    return true;
  }

  return hasGoogleLanguage(config.allowedLanguages, trimmed);
}

function shouldUseGlossary(
  config: RuntimeConfig["googleTranslate"],
  payload: {
    sourceLanguage: string;
    targetLanguage: string;
  }
): boolean {
  if (!config.glossary) {
    return false;
  }

  if (!hasGoogleLanguage(config.glossaryLanguages, payload.targetLanguage)) {
    return false;
  }

  return payload.sourceLanguage !== "auto"
    && hasGoogleLanguage(config.glossaryLanguages, payload.sourceLanguage);
}

function shouldUseAutoDetectedGlossary(
  config: RuntimeConfig["googleTranslate"],
  targetLanguage: string
): boolean {
  return Boolean(config.glossary) && hasGoogleLanguage(config.glossaryLanguages, targetLanguage);
}

function getGlossaryKey(
  config: RuntimeConfig["googleTranslate"],
  payload: {
    sourceLanguage: string;
    targetLanguage: string;
  }
): string {
  return shouldUseGlossary(config, payload) ? config.glossary ?? "" : "";
}

function getLookupGlossaryKeys(
  config: RuntimeConfig["googleTranslate"],
  payload: {
    sourceLanguage: string;
    targetLanguage: string;
  }
): string[] {
  if (payload.sourceLanguage === "auto") {
    return shouldUseAutoDetectedGlossary(config, payload.targetLanguage) ? [config.glossary ?? "", ""] : [""];
  }

  return [getGlossaryKey(config, payload)];
}

function getWriteGlossaryKey(
  config: RuntimeConfig["googleTranslate"],
  payload: {
    sourceLanguage: string;
    targetLanguage: string;
    glossaryApplied: boolean;
  }
): string {
  if (!payload.glossaryApplied) {
    return "";
  }

  return getGlossaryKey(config, payload);
}

function getGlossaryCacheVersion(glossaryKey: string, glossaryVersion: string): string {
  return glossaryKey ? glossaryVersion : TRANSLATION_NO_GLOSSARY_CACHE_VERSION;
}

async function getTextTranslationTargetDescriptor(payload: {
  targetLanguage: string;
  glossaryKey: string;
  glossaryVersion: string;
  normalizedText: string;
}): Promise<TextTranslationTargetDescriptor> {
  const targetLanguage = toTranslationCacheLanguage(payload.targetLanguage);
  const glossaryVersion = getGlossaryCacheVersion(payload.glossaryKey, payload.glossaryVersion);
  const textHash = await sha256Hex(payload.normalizedText);
  return {
    detectionCacheKey: [
      TRANSLATION_KV_CACHE_PREFIX,
      glossaryVersion,
      GOOGLE_TRANSLATION_CACHE_PROVIDER,
      "detect",
      targetLanguage,
      textHash
    ].join(":"),
    textHash,
    targetLanguage,
    glossaryVersion,
    glossaryKey: payload.glossaryKey
  };
}

async function getTextTranslationCacheDescriptor(payload: {
  sourceLanguage: string;
  targetLanguage: string;
  glossaryKey: string;
  glossaryVersion: string;
  normalizedText: string;
}): Promise<TextTranslationCacheDescriptor> {
  const sourceLanguage = toTranslationCacheLanguage(payload.sourceLanguage);
  const targetLanguage = toTranslationCacheLanguage(payload.targetLanguage);
  const glossaryVersion = getGlossaryCacheVersion(payload.glossaryKey, payload.glossaryVersion);
  const textHash = await sha256Hex(payload.normalizedText);
  const flowVersion = [
    TRANSLATION_KV_CACHE_PREFIX,
    glossaryVersion,
    GOOGLE_TRANSLATION_CACHE_PROVIDER,
    sourceLanguage,
    targetLanguage
  ].join(":");

  return {
    cacheKey: `${flowVersion}:${textHash}`,
    textHash,
    flowVersion,
    sourceLanguage,
    targetLanguage,
    glossaryVersion,
    glossaryKey: payload.glossaryKey
  };
}

function getTextTranslationCacheDescriptorFromRecord(record: TextTranslationRecord): TextTranslationCacheDescriptor {
  return {
    cacheKey: record.cacheKey,
    textHash: record.textHash,
    flowVersion: record.flowVersion,
    sourceLanguage: record.sourceLanguage,
    targetLanguage: record.targetLanguage,
    glossaryVersion: record.glossaryVersion,
    glossaryKey: record.glossaryKey
  };
}

function getTextTranslationCacheDescriptorFromTarget(
  sourceLanguage: string,
  targetDescriptor: TextTranslationTargetDescriptor
): TextTranslationCacheDescriptor {
  const normalizedSourceLanguage = toTranslationCacheLanguage(sourceLanguage);
  const flowVersion = [
    TRANSLATION_KV_CACHE_PREFIX,
    targetDescriptor.glossaryVersion,
    GOOGLE_TRANSLATION_CACHE_PROVIDER,
    normalizedSourceLanguage,
    targetDescriptor.targetLanguage
  ].join(":");

  return {
    cacheKey: `${flowVersion}:${targetDescriptor.textHash}`,
    textHash: targetDescriptor.textHash,
    flowVersion,
    sourceLanguage: normalizedSourceLanguage,
    targetLanguage: targetDescriptor.targetLanguage,
    glossaryVersion: targetDescriptor.glossaryVersion,
    glossaryKey: targetDescriptor.glossaryKey
  };
}

async function getCachedTextTranslation(
  kv: KVNamespace | undefined,
  descriptor: TextTranslationCacheDescriptor
): Promise<TextTranslationCacheRecord | null> {
  const cached = await getJsonFromKv<unknown>(kv, descriptor.cacheKey);
  if (!cached || typeof cached !== "object") {
    return null;
  }

  const record = cached as Partial<TextTranslationCacheRecord>;
  if (
    typeof record.translatedText !== "string" ||
    record.translatedText.length === 0 ||
    record.provider !== GOOGLE_TRANSLATION_PROVIDER ||
    record.targetLanguage !== descriptor.targetLanguage ||
    record.glossaryKey !== descriptor.glossaryKey ||
    record.glossaryVersion !== descriptor.glossaryVersion ||
    record.flowVersion !== descriptor.flowVersion
  ) {
    return null;
  }

  return {
    translatedText: record.translatedText,
    sourceLanguage: typeof record.sourceLanguage === "string" ? record.sourceLanguage : descriptor.sourceLanguage,
    detectedSourceLanguage: typeof record.detectedSourceLanguage === "string"
      ? record.detectedSourceLanguage
      : undefined,
    targetLanguage: record.targetLanguage,
    provider: record.provider,
    glossaryApplied: record.glossaryApplied === true,
    glossaryKey: record.glossaryKey,
    glossaryVersion: record.glossaryVersion,
    flowVersion: record.flowVersion,
    translatedAt: typeof record.translatedAt === "string" ? record.translatedAt : ""
  };
}

async function getDetectedSourceFromKv(
  kv: KVNamespace | undefined,
  descriptor: TextTranslationTargetDescriptor
): Promise<TextTranslationDetectionCacheRecord | null> {
  const cached = await getJsonFromKv<unknown>(kv, descriptor.detectionCacheKey);
  if (!cached || typeof cached !== "object") {
    return null;
  }

  const record = cached as Partial<TextTranslationDetectionCacheRecord>;
  if (
    typeof record.sourceLanguage !== "string" ||
    typeof record.cacheKey !== "string" ||
    record.provider !== GOOGLE_TRANSLATION_PROVIDER ||
    record.textHash !== descriptor.textHash ||
    record.targetLanguage !== descriptor.targetLanguage ||
    record.glossaryVersion !== descriptor.glossaryVersion ||
    record.glossaryKey !== descriptor.glossaryKey
  ) {
    return null;
  }

  return {
    sourceLanguage: record.sourceLanguage,
    cacheKey: record.cacheKey,
    textHash: record.textHash,
    targetLanguage: record.targetLanguage,
    provider: record.provider,
    glossaryVersion: record.glossaryVersion,
    glossaryKey: record.glossaryKey,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : ""
  };
}

async function putCachedTextTranslationToKv(
  kv: KVNamespace | undefined,
  descriptor: TextTranslationCacheDescriptor,
  payload: {
    detectedSourceLanguage?: string;
    translatedText: string;
    glossaryApplied: boolean;
    translatedAt?: string;
  }
): Promise<void> {
  const record: TextTranslationCacheRecord = {
    translatedText: payload.translatedText,
    sourceLanguage: descriptor.sourceLanguage,
    detectedSourceLanguage: payload.detectedSourceLanguage
      ? toTranslationCacheLanguage(payload.detectedSourceLanguage)
      : undefined,
    targetLanguage: descriptor.targetLanguage,
    provider: GOOGLE_TRANSLATION_PROVIDER,
    glossaryApplied: payload.glossaryApplied,
    glossaryKey: descriptor.glossaryKey,
    glossaryVersion: descriptor.glossaryVersion,
    flowVersion: descriptor.flowVersion,
    translatedAt: payload.translatedAt ?? new Date().toISOString()
  };
  await putJsonToKv(kv, descriptor.cacheKey, record);
}

async function putDetectedSourceToKv(
  kv: KVNamespace | undefined,
  targetDescriptor: TextTranslationTargetDescriptor,
  translationDescriptor: TextTranslationCacheDescriptor
): Promise<void> {
  const record: TextTranslationDetectionCacheRecord = {
    sourceLanguage: translationDescriptor.sourceLanguage,
    cacheKey: translationDescriptor.cacheKey,
    textHash: targetDescriptor.textHash,
    targetLanguage: targetDescriptor.targetLanguage,
    provider: GOOGLE_TRANSLATION_PROVIDER,
    glossaryVersion: targetDescriptor.glossaryVersion,
    glossaryKey: targetDescriptor.glossaryKey,
    createdAt: new Date().toISOString()
  };
  await putJsonToKv(kv, targetDescriptor.detectionCacheKey, record);
}

async function putCachedTextTranslationToD1(
  db: D1Database,
  descriptor: TextTranslationCacheDescriptor,
  payload: {
    detectedSourceLanguage?: string;
    translatedText: string;
    glossaryApplied: boolean;
  }
): Promise<void> {
  await upsertTextTranslation(db, {
    cacheKey: descriptor.cacheKey,
    textHash: descriptor.textHash,
    flowVersion: descriptor.flowVersion,
    sourceLanguage: descriptor.sourceLanguage,
    detectedSourceLanguage: payload.detectedSourceLanguage
      ? toTranslationCacheLanguage(payload.detectedSourceLanguage)
      : null,
    targetLanguage: descriptor.targetLanguage,
    provider: GOOGLE_TRANSLATION_PROVIDER,
    glossaryVersion: descriptor.glossaryVersion,
    glossaryKey: descriptor.glossaryKey,
    translatedContent: payload.translatedText,
    glossaryApplied: payload.glossaryApplied
  });
}

function cacheRecordFromD1(record: TextTranslationRecord): TextTranslationCacheRecord {
  return {
    translatedText: record.translatedContent,
    sourceLanguage: record.sourceLanguage,
    detectedSourceLanguage: record.detectedSourceLanguage ?? undefined,
    targetLanguage: record.targetLanguage,
    provider: record.provider,
    glossaryApplied: record.glossaryApplied,
    glossaryKey: record.glossaryKey,
    glossaryVersion: record.glossaryVersion,
    flowVersion: record.flowVersion,
    translatedAt: record.translatedAt
  };
}

async function getCachedOrStoredTextTranslationByDescriptor(
  env: Bindings,
  descriptor: TextTranslationCacheDescriptor
): Promise<TextTranslationCacheRecord | null> {
  const textCached = await getCachedTextTranslation(env.OEM_KV, descriptor);
  if (textCached?.translatedText) {
    return textCached;
  }

  const storedTextTranslation = await getTextTranslation(env.DB, descriptor.cacheKey);
  if (!storedTextTranslation?.translatedContent) {
    return null;
  }

  const record = cacheRecordFromD1(storedTextTranslation);
  await putCachedTextTranslationToKv(env.OEM_KV, getTextTranslationCacheDescriptorFromRecord(storedTextTranslation), {
    detectedSourceLanguage: record.detectedSourceLanguage,
    translatedText: record.translatedText,
    glossaryApplied: record.glossaryApplied,
    translatedAt: record.translatedAt
  });
  return record;
}

async function getCachedOrStoredAutoTextTranslation(
  env: Bindings,
  targetDescriptor: TextTranslationTargetDescriptor
): Promise<TextTranslationCacheRecord | null> {
  const detectedSource = await getDetectedSourceFromKv(env.OEM_KV, targetDescriptor);
  if (detectedSource) {
    const descriptor = getTextTranslationCacheDescriptorFromTarget(detectedSource.sourceLanguage, targetDescriptor);
    const record = await getCachedOrStoredTextTranslationByDescriptor(env, descriptor);
    if (record) {
      return record;
    }
  }

  const storedTextTranslation = await getTextTranslationByTarget(env.DB, {
    textHash: targetDescriptor.textHash,
    targetLanguage: targetDescriptor.targetLanguage,
    provider: GOOGLE_TRANSLATION_PROVIDER,
    glossaryVersion: targetDescriptor.glossaryVersion,
    glossaryKey: targetDescriptor.glossaryKey
  });
  if (!storedTextTranslation?.translatedContent) {
    return null;
  }

  const record = cacheRecordFromD1(storedTextTranslation);
  const descriptor = getTextTranslationCacheDescriptorFromRecord(storedTextTranslation);
  await Promise.all([
    putCachedTextTranslationToKv(env.OEM_KV, descriptor, {
      detectedSourceLanguage: record.detectedSourceLanguage,
      translatedText: record.translatedText,
      glossaryApplied: record.glossaryApplied,
      translatedAt: record.translatedAt
    }),
    putDetectedSourceToKv(env.OEM_KV, targetDescriptor, descriptor)
  ]);
  return record;
}

async function putCachedTextTranslation(
  env: Bindings,
  config: RuntimeConfig["googleTranslate"],
  payload: {
    sourceLanguage: string;
    detectedSourceLanguage?: string;
    targetLanguage: string;
    normalizedText: string;
    translatedText: string;
    glossaryApplied: boolean;
  }
): Promise<void> {
  const sourceLanguage = payload.sourceLanguage === "auto"
    ? payload.detectedSourceLanguage
    : payload.sourceLanguage;
  if (!sourceLanguage?.trim()) {
    return;
  }

  const glossaryKey = getWriteGlossaryKey(config, {
    sourceLanguage,
    targetLanguage: payload.targetLanguage,
    glossaryApplied: payload.glossaryApplied
  });
  const descriptor = await getTextTranslationCacheDescriptor({
    sourceLanguage,
    targetLanguage: payload.targetLanguage,
    glossaryKey,
    glossaryVersion: config.glossaryVersion,
    normalizedText: payload.normalizedText
  });
  const targetDescriptor = await getTextTranslationTargetDescriptor({
    targetLanguage: payload.targetLanguage,
    glossaryKey,
    glossaryVersion: config.glossaryVersion,
    normalizedText: payload.normalizedText
  });

  await Promise.all([
    putCachedTextTranslationToD1(env.DB, descriptor, {
      detectedSourceLanguage: payload.detectedSourceLanguage,
      translatedText: payload.translatedText,
      glossaryApplied: payload.glossaryApplied
    }),
    putCachedTextTranslationToKv(env.OEM_KV, descriptor, {
      detectedSourceLanguage: payload.detectedSourceLanguage,
      translatedText: payload.translatedText,
      glossaryApplied: payload.glossaryApplied
    }),
    payload.sourceLanguage === "auto"
      ? putDetectedSourceToKv(env.OEM_KV, targetDescriptor, descriptor)
      : Promise.resolve()
  ]);
}

function normalizeSourceLanguage(sourceLanguage: string | undefined): string {
  return sourceLanguage?.trim() || "auto";
}

function isGoogleTranslateConfigured(config: RuntimeConfig["googleTranslate"]): boolean {
  return Boolean(config.clientEmail && config.privateKey && config.projectId);
}

function itemFromCachedTextTranslation(
  commentId: string,
  targetLanguage: string,
  record: TextTranslationCacheRecord
): CommentTranslationItem {
  return {
    commentId,
    translatedContent: record.translatedText,
    sourceLanguage: record.detectedSourceLanguage ?? record.sourceLanguage,
    targetLanguage,
    provider: record.provider,
    glossaryApplied: record.glossaryApplied,
    cached: true
  };
}

async function callGoogleTranslateRequest(
  config: RuntimeConfig["googleTranslate"],
  payload: {
    contents: string[];
    sourceLanguage: string;
    targetLanguage: string;
    glossary: boolean;
  }
): Promise<Array<{ translatedText: string; detectedLanguageCode?: string; glossaryApplied: boolean }>> {
  if (!config.projectId) {
    throw new Error("Google Translation project id is not configured.");
  }

  const token = await getGoogleAccessToken(config);
  const parent = `projects/${config.projectId}/locations/${config.location}`;
  const body: Record<string, unknown> = {
    contents: payload.contents,
    targetLanguageCode: toGoogleLanguageCode(payload.targetLanguage),
    mimeType: "text/plain"
  };
  if (payload.sourceLanguage !== "auto") {
    body.sourceLanguageCode = toGoogleLanguageCode(payload.sourceLanguage);
  }
  if (payload.glossary) {
    body.glossaryConfig = {
      glossary: config.glossary
    };
  }

  const response = await fetchWithTimeout(
    "google-translate",
    `https://translation.googleapis.com/v3/${parent}:translateText`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    },
    config.fetchProxyUrl
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Google Translation request failed (${response.status}). ${errorText.slice(0, 300)}`.trim());
  }

  const data = (await response.json()) as GoogleTranslateResponse;
  const glossaryTranslations = data.glossaryTranslations;
  const translations = glossaryTranslations ?? data.translations ?? [];
  return translations.map((translation) => ({
    translatedText: translation.translatedText ?? "",
    detectedLanguageCode: translation.detectedLanguageCode,
    glossaryApplied: Boolean(glossaryTranslations)
  }));
}

async function callGoogleTranslate(
  config: RuntimeConfig["googleTranslate"],
  payload: {
    contents: string[];
    sourceLanguage: string;
    targetLanguage: string;
  }
): Promise<Array<{ translatedText: string; detectedLanguageCode?: string; glossaryApplied: boolean }>> {
  if (payload.sourceLanguage !== "auto") {
    return callGoogleTranslateRequest(config, {
      ...payload,
      glossary: shouldUseGlossary(config, payload)
    });
  }

  const baseTranslations = await callGoogleTranslateRequest(config, {
    ...payload,
    glossary: false
  });
  if (!shouldUseAutoDetectedGlossary(config, payload.targetLanguage)) {
    return baseTranslations;
  }

  const indexesBySourceLanguage = new Map<string, number[]>();
  baseTranslations.forEach((translation, index) => {
    const detected = translation.detectedLanguageCode;
    if (!detected || !hasGoogleLanguage(config.glossaryLanguages, detected)) {
      return;
    }
    const googleLanguage = toGoogleLanguageCode(detected);
    indexesBySourceLanguage.set(
      googleLanguage,
      [...(indexesBySourceLanguage.get(googleLanguage) ?? []), index]
    );
  });

  await Promise.all([...indexesBySourceLanguage.entries()].map(async ([sourceLanguage, indexes]) => {
    const glossaryTranslations = await callGoogleTranslateRequest(config, {
      contents: indexes.map((index) => payload.contents[index] ?? ""),
      sourceLanguage,
      targetLanguage: payload.targetLanguage,
      glossary: true
    });
    glossaryTranslations.forEach((translation, localIndex) => {
      const originalIndex = indexes[localIndex];
      if (originalIndex === undefined || !translation.translatedText) {
        return;
      }
      baseTranslations[originalIndex] = {
        ...translation,
        detectedLanguageCode: translation.detectedLanguageCode ?? sourceLanguage,
        glossaryApplied: true
      };
    });
  }));

  return baseTranslations;
}

export async function translateVisibleComments(
  env: Bindings,
  payload: {
    commentIds: string[];
    sourceLanguage?: string;
    targetLanguage: string;
  }
): Promise<{ items: CommentTranslationItem[] }> {
  const config = getRuntimeConfig(env).googleTranslate;
  const commentIds = [...new Set(payload.commentIds.map((id) => id.trim()).filter(Boolean))].slice(0, MAX_TRANSLATION_BATCH_SIZE);
  const targetLanguage = payload.targetLanguage.trim();
  const sourceLanguage = normalizeSourceLanguage(payload.sourceLanguage);
  const lookupGlossaryKeys = getLookupGlossaryKeys(config, { sourceLanguage, targetLanguage });

  if (!validateLanguage(config, targetLanguage) || (sourceLanguage !== "auto" && !validateLanguage(config, sourceLanguage))) {
    return {
      items: commentIds.map((commentId) => ({
        commentId,
        targetLanguage,
        provider: GOOGLE_TRANSLATION_PROVIDER,
        glossaryApplied: false,
        cached: false,
        error: "LANGUAGE_NOT_ALLOWED"
      }))
    };
  }

  const comments = await getVisibleCommentsByIds(env.DB, commentIds);
  const commentById = new Map(comments.map((comment) => [comment.id, comment]));
  const normalizedTextById = new Map<string, string>();
  comments.forEach((comment) => {
    normalizedTextById.set(comment.id, normalizeTextForTranslationCache(comment.content ?? ""));
  });

  const items = new Map<string, CommentTranslationItem>();
  const misses: SubmissionRecord[] = [];

  for (const commentId of commentIds) {
    const comment = commentById.get(commentId);
    if (!comment) {
      items.set(commentId, {
        commentId,
        targetLanguage,
        provider: GOOGLE_TRANSLATION_PROVIDER,
        glossaryApplied: false,
        cached: false,
        error: "COMMENT_NOT_TRANSLATABLE"
      });
      continue;
    }

    const normalizedText = normalizedTextById.get(comment.id) ?? "";
    let cachedRecord: TextTranslationCacheRecord | null = null;
    for (const lookupGlossaryKey of lookupGlossaryKeys) {
      if (sourceLanguage === "auto") {
        const targetDescriptor = await getTextTranslationTargetDescriptor({
          targetLanguage,
          glossaryKey: lookupGlossaryKey,
          glossaryVersion: config.glossaryVersion,
          normalizedText
        });
        cachedRecord = await getCachedOrStoredAutoTextTranslation(env, targetDescriptor);
      } else {
        const descriptor = await getTextTranslationCacheDescriptor({
          sourceLanguage,
          targetLanguage,
          glossaryKey: lookupGlossaryKey,
          glossaryVersion: config.glossaryVersion,
          normalizedText
        });
        cachedRecord = await getCachedOrStoredTextTranslationByDescriptor(env, descriptor);
      }
      if (cachedRecord) {
        break;
      }
    }
    if (cachedRecord) {
      items.set(commentId, itemFromCachedTextTranslation(commentId, targetLanguage, cachedRecord));
      continue;
    }

    misses.push(comment);
  }

  if (misses.length > 0) {
    try {
      const translated = await callGoogleTranslate(config, {
        contents: misses.map((comment) => comment.content ?? ""),
        sourceLanguage,
        targetLanguage
      });

      await Promise.all(misses.map(async (comment, index) => {
        const translation = translated[index];
        if (!translation?.translatedText) {
          items.set(comment.id, {
            commentId: comment.id,
            targetLanguage,
            provider: GOOGLE_TRANSLATION_PROVIDER,
            glossaryApplied: false,
            cached: false,
            error: "TRANSLATION_EMPTY"
          });
          return;
        }

        const normalizedText = normalizedTextById.get(comment.id) ?? "";
        await putCachedTextTranslation(env, config, {
          sourceLanguage,
          detectedSourceLanguage: translation.detectedLanguageCode,
          targetLanguage,
          normalizedText,
          translatedText: translation.translatedText,
          glossaryApplied: translation.glossaryApplied
        });
        items.set(comment.id, {
          commentId: comment.id,
          translatedContent: translation.translatedText,
          sourceLanguage: translation.detectedLanguageCode ?? sourceLanguage,
          targetLanguage,
          provider: GOOGLE_TRANSLATION_PROVIDER,
          glossaryApplied: translation.glossaryApplied,
          cached: false
        });
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Translation failed.";
      misses.forEach((comment) => {
        items.set(comment.id, {
          commentId: comment.id,
          targetLanguage,
          provider: GOOGLE_TRANSLATION_PROVIDER,
          glossaryApplied: false,
          cached: false,
          error: message
        });
      });
    }
  }

  return {
    items: commentIds.map((commentId) => items.get(commentId) ?? {
      commentId,
      targetLanguage,
      provider: GOOGLE_TRANSLATION_PROVIDER,
      glossaryApplied: false,
      cached: false,
      error: "COMMENT_NOT_TRANSLATABLE"
    })
  };
}

export async function prewarmApprovedCommentTranslations(
  env: Bindings,
  commentId: string
): Promise<{ ok: boolean; skipped?: string; targets: string[] }> {
  const id = commentId.trim();
  const targets = [...APPROVED_COMMENT_PREWARM_TARGET_LANGUAGES];
  if (!id) {
    return { ok: false, skipped: "COMMENT_ID_EMPTY", targets };
  }

  const config = getRuntimeConfig(env).googleTranslate;
  if (!isGoogleTranslateConfigured(config)) {
    return { ok: true, skipped: "GOOGLE_TRANSLATE_NOT_CONFIGURED", targets };
  }

  await Promise.all(targets.map((targetLanguage) =>
    translateVisibleComments(env, {
      commentIds: [id],
      sourceLanguage: "auto",
      targetLanguage
    })
  ));

  return { ok: true, targets };
}
