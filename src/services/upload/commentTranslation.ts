import { getRuntimeConfig, type RuntimeConfig } from "../../lib/config";
import { getJsonFromKv, putJsonToKv, sha256Hex } from "../../middleware/cache/kvJson";
import { getVisibleCommentsByIds } from "../../repositories/submission/statusSubmission";
import type { SubmissionRecord } from "../../repositories/submission/types";
import type { Bindings } from "../../types/app";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_TRANSLATION_SCOPE = "https://www.googleapis.com/auth/cloud-translation";
const GOOGLE_TRANSLATION_PROVIDER = "google_cloud_translation_v3";
const GOOGLE_TRANSLATION_CACHE_PROVIDER = "google-v3";
const GOOGLE_ACCESS_TOKEN_SKEW_SECONDS = 60;
const MAX_TRANSLATION_BATCH_SIZE = 100;
const TRANSLATION_KV_CACHE_PREFIX = "translate:v1";
const TRANSLATION_NO_GLOSSARY_CACHE_VERSION = "g0";
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
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

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

  return payload.sourceLanguage === "auto"
    || hasGoogleLanguage(config.glossaryLanguages, payload.sourceLanguage);
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

function getGlossaryCacheVersion(glossaryKey: string, glossaryVersion: string): string {
  return glossaryKey ? glossaryVersion : TRANSLATION_NO_GLOSSARY_CACHE_VERSION;
}

async function getTextTranslationCacheKey(payload: {
  sourceLanguage: string;
  targetLanguage: string;
  glossaryKey: string;
  glossaryVersion: string;
  normalizedText: string;
}): Promise<string> {
  return [
    TRANSLATION_KV_CACHE_PREFIX,
    getGlossaryCacheVersion(payload.glossaryKey, payload.glossaryVersion),
    GOOGLE_TRANSLATION_CACHE_PROVIDER,
    toTranslationCacheLanguage(payload.sourceLanguage),
    toTranslationCacheLanguage(payload.targetLanguage),
    await sha256Hex(payload.normalizedText)
  ].join(":");
}

async function getCachedTextTranslation(
  kv: KVNamespace | undefined,
  payload: {
    sourceLanguage: string;
    targetLanguage: string;
    glossaryKey: string;
    glossaryVersion: string;
    normalizedText: string;
  }
): Promise<TextTranslationCacheRecord | null> {
  const cached = await getJsonFromKv<unknown>(
    kv,
    await getTextTranslationCacheKey(payload)
  );
  if (!cached || typeof cached !== "object") {
    return null;
  }

  const record = cached as Partial<TextTranslationCacheRecord>;
  if (
    typeof record.translatedText !== "string" ||
    record.translatedText.length === 0 ||
    record.provider !== GOOGLE_TRANSLATION_PROVIDER ||
    record.targetLanguage !== toTranslationCacheLanguage(payload.targetLanguage) ||
    record.glossaryKey !== payload.glossaryKey
  ) {
    return null;
  }

  return {
    translatedText: record.translatedText,
    sourceLanguage: typeof record.sourceLanguage === "string" ? record.sourceLanguage : payload.sourceLanguage,
    detectedSourceLanguage: typeof record.detectedSourceLanguage === "string"
      ? record.detectedSourceLanguage
      : undefined,
    targetLanguage: record.targetLanguage,
    provider: record.provider,
    glossaryApplied: record.glossaryApplied === true,
    glossaryKey: record.glossaryKey,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : ""
  };
}

async function putCachedTextTranslation(
  kv: KVNamespace | undefined,
  payload: {
    sourceLanguage: string;
    detectedSourceLanguage?: string;
    targetLanguage: string;
    glossaryKey: string;
    glossaryVersion: string;
    normalizedText: string;
    translatedText: string;
    glossaryApplied: boolean;
  }
): Promise<void> {
  const record: TextTranslationCacheRecord = {
    translatedText: payload.translatedText,
    sourceLanguage: toTranslationCacheLanguage(payload.sourceLanguage),
    detectedSourceLanguage: payload.detectedSourceLanguage
      ? toTranslationCacheLanguage(payload.detectedSourceLanguage)
      : undefined,
    targetLanguage: toTranslationCacheLanguage(payload.targetLanguage),
    provider: GOOGLE_TRANSLATION_PROVIDER,
    glossaryApplied: payload.glossaryApplied,
    glossaryKey: payload.glossaryKey,
    createdAt: new Date().toISOString()
  };
  const sourceLanguages = new Set([
    payload.sourceLanguage,
    payload.detectedSourceLanguage
  ].filter((language): language is string => Boolean(language?.trim())));

  await Promise.all([...sourceLanguages].map(async (sourceLanguage) => {
    await putJsonToKv(
      kv,
      await getTextTranslationCacheKey({
        sourceLanguage,
        targetLanguage: payload.targetLanguage,
        glossaryKey: payload.glossaryKey,
        glossaryVersion: payload.glossaryVersion,
        normalizedText: payload.normalizedText
      }),
      {
        ...record,
        sourceLanguage: toTranslationCacheLanguage(sourceLanguage)
      }
    );
  }));
}

function normalizeSourceLanguage(sourceLanguage: string | undefined): string {
  return sourceLanguage?.trim() || "auto";
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

async function callGoogleTranslate(
  config: RuntimeConfig["googleTranslate"],
  payload: {
    contents: string[];
    sourceLanguage: string;
    targetLanguage: string;
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
  if (shouldUseGlossary(config, payload)) {
    body.glossaryConfig = {
      glossary: config.glossary
    };
  }

  const response = await fetch(
    `https://translation.googleapis.com/v3/${parent}:translateText`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    throw new Error(`Google Translation request failed (${response.status}).`);
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
  const glossaryKey = getGlossaryKey(config, { sourceLanguage, targetLanguage });

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

    const textCached = await getCachedTextTranslation(env.OEM_KV, {
      sourceLanguage,
      targetLanguage,
      glossaryKey,
      glossaryVersion: config.glossaryVersion,
      normalizedText: normalizedTextById.get(comment.id) ?? ""
    });
    if (textCached?.translatedText) {
      items.set(commentId, itemFromCachedTextTranslation(commentId, targetLanguage, textCached));
    } else {
      misses.push(comment);
    }
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
        await putCachedTextTranslation(env.OEM_KV, {
          sourceLanguage,
          detectedSourceLanguage: translation.detectedLanguageCode,
          targetLanguage,
          glossaryKey,
          glossaryVersion: config.glossaryVersion,
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
