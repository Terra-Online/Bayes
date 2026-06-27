import { getRuntimeConfig, type RuntimeConfig } from "../lib/config";
import { sha256Hex } from "../lib/kv-cache";
import {
  getCommentTranslations,
  getVisibleCommentsByIds,
  upsertCommentTranslation,
  type CommentTranslationRecord,
  type SubmissionRecord
} from "../repositories/submissions";
import type { Bindings } from "../types/app";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_TRANSLATION_SCOPE = "https://www.googleapis.com/auth/cloud-translation";
const GOOGLE_TRANSLATION_PROVIDER = "google_cloud_translation_v3";
const GOOGLE_ACCESS_TOKEN_SKEW_SECONDS = 60;
const MAX_TRANSLATION_BATCH_SIZE = 100;

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

function getGlossaryKey(config: RuntimeConfig["googleTranslate"]): string {
  return config.glossary ?? "";
}

function validateLanguage(config: RuntimeConfig["googleTranslate"], language: string): boolean {
  return config.allowedLanguages.has(language);
}

function normalizeSourceLanguage(sourceLanguage: string | undefined): string {
  return sourceLanguage?.trim() || "auto";
}

function translationCacheKey(payload: {
  commentId: string;
  sourceLanguage: string;
  targetLanguage: string;
  glossaryKey: string;
  sourceHash: string;
}): string {
  return [
    payload.commentId,
    payload.sourceLanguage,
    payload.targetLanguage,
    payload.glossaryKey,
    payload.sourceHash
  ].join("\u001f");
}

function itemFromCachedTranslation(record: CommentTranslationRecord): CommentTranslationItem {
  return {
    commentId: record.commentId,
    translatedContent: record.translatedContent,
    sourceLanguage: record.detectedSourceLanguage ?? record.sourceLanguage,
    targetLanguage: record.targetLanguage,
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
    targetLanguageCode: payload.targetLanguage,
    mimeType: "text/plain"
  };
  if (payload.sourceLanguage !== "auto") {
    body.sourceLanguageCode = payload.sourceLanguage;
  }
  if (config.glossary) {
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
  const glossaryKey = getGlossaryKey(config);

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
  const sourceHashes = new Map<string, string>();
  await Promise.all(comments.map(async (comment) => {
    sourceHashes.set(comment.id, await sha256Hex(comment.content ?? ""));
  }));

  const cachedRecords = await getCommentTranslations(env.DB, {
    commentIds: comments.map((comment) => comment.id),
    sourceLanguage,
    targetLanguage,
    glossaryKey,
    sourceHashes
  });
  const cachedByKey = new Map(
    cachedRecords.map((record) => [
      translationCacheKey({
        commentId: record.commentId,
        sourceLanguage: record.sourceLanguage,
        targetLanguage: record.targetLanguage,
        glossaryKey: record.glossaryKey,
        sourceHash: record.sourceHash
      }),
      record
    ])
  );

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

    const sourceHash = sourceHashes.get(comment.id) ?? "";
    const cached = cachedByKey.get(translationCacheKey({
      commentId: comment.id,
      sourceLanguage,
      targetLanguage,
      glossaryKey,
      sourceHash
    }));
    if (cached) {
      items.set(commentId, itemFromCachedTranslation(cached));
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

        const sourceHash = sourceHashes.get(comment.id) ?? "";
        await upsertCommentTranslation(env.DB, {
          commentId: comment.id,
          sourceLanguage,
          detectedSourceLanguage: translation.detectedLanguageCode,
          targetLanguage,
          glossaryKey,
          sourceHash,
          translatedContent: translation.translatedText,
          provider: GOOGLE_TRANSLATION_PROVIDER,
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
