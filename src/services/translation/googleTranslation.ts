import type { RuntimeConfig } from "@/lib/config";

import { shouldUseGlossary, shouldUseAutoDetectedGlossary } from "./glossary";
import {
  normalizeTranslationLanguage,
  isSameTranslationLanguage,
  hasTranslationLanguage,
} from "./languages";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_TRANSLATION_SCOPE = "https://www.googleapis.com/auth/cloud-translation";
export const GOOGLE_TRANSLATION_PROVIDER = "google_cloud_translation_v3";
const GOOGLE_ACCESS_TOKEN_SKEW_SECONDS = 60;
const GOOGLE_FETCH_TIMEOUT_MS = 15_000;

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

export type TranslationResult = {
  translatedText: string;
  detectedLanguageCode?: string;
  glossaryApplied: boolean;
};

type GoogleFetchProxyResponse = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
};

let cachedGoogleAccessToken: CachedGoogleAccessToken | null = null;

function base64UrlEncode(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
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
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
}

async function createGoogleJwt(config: RuntimeConfig["googleTranslate"]): Promise<string> {
  if (!config.clientEmail || !config.privateKey) {
    throw new Error("Google Translation service account is not configured.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const claim = {
    iss: config.clientEmail,
    scope: GOOGLE_TRANSLATION_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claim))}`;
  const key = await importPrivateKey(config.privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

async function getGoogleAccessToken(config: RuntimeConfig["googleTranslate"]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (
    cachedGoogleAccessToken &&
    cachedGoogleAccessToken.expiresAt - GOOGLE_ACCESS_TOKEN_SKEW_SECONDS > now
  ) {
    return cachedGoogleAccessToken.token;
  }

  const assertion = await createGoogleJwt(config);
  const response = await fetchWithTimeout(
    "google-token",
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    },
    config.fetchProxyUrl,
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
    expiresAt: now + Math.max(60, Number(payload.expires_in ?? 3600)),
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
  signal: AbortSignal,
): Promise<Response> {
  const proxyResponse = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: input,
      method: init.method ?? "GET",
      headers: serializeFetchHeaders(init.headers),
      body: serializeFetchBody(init.body),
    }),
    signal,
  });
  if (!proxyResponse.ok) {
    throw new Error(`Google local fetch proxy failed (${proxyResponse.status}).`);
  }

  const payload = (await proxyResponse.json()) as GoogleFetchProxyResponse;
  return new Response(payload.body ?? "", {
    status: payload.status ?? 502,
    headers: payload.headers,
  });
}

async function fetchWithTimeout(
  label: string,
  input: string,
  init: RequestInit,
  proxyUrl?: string,
  timeoutMs = GOOGLE_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("Google Translation request timed out."),
    timeoutMs,
  );
  try {
    return proxyUrl
      ? await fetchThroughLocalProxy(proxyUrl, input, init, controller.signal)
      : await fetch(input, {
          ...init,
          signal: controller.signal,
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

export function isGoogleTranslateConfigured(config: RuntimeConfig["googleTranslate"]): boolean {
  return Boolean(config.clientEmail && config.privateKey && config.projectId);
}

async function callGoogleTranslateRequest(
  config: RuntimeConfig["googleTranslate"],
  payload: {
    contents: string[];
    sourceLanguage: string;
    targetLanguage: string;
    glossary: boolean;
  },
): Promise<TranslationResult[]> {
  if (!config.projectId) {
    throw new Error("Google Translation project id is not configured.");
  }

  const token = await getGoogleAccessToken(config);
  const parent = `projects/${config.projectId}/locations/${config.location}`;
  const body: Record<string, unknown> = {
    contents: payload.contents,
    targetLanguageCode: normalizeTranslationLanguage(payload.targetLanguage),
    mimeType: "text/plain",
  };
  if (payload.sourceLanguage !== "auto") {
    body.sourceLanguageCode = normalizeTranslationLanguage(payload.sourceLanguage);
  }
  if (payload.glossary) {
    body.glossaryConfig = {
      glossary: config.glossary,
    };
  }

  const response = await fetchWithTimeout(
    "google-translate",
    `https://translation.googleapis.com/v3/${parent}:translateText`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    config.fetchProxyUrl,
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Google Translation request failed (${response.status}). ${errorText.slice(0, 300)}`.trim(),
    );
  }

  const data = (await response.json()) as GoogleTranslateResponse;
  const glossaryTranslations = data.glossaryTranslations;
  const translations = glossaryTranslations ?? data.translations ?? [];
  return translations.map((translation) => ({
    translatedText: translation.translatedText ?? "",
    detectedLanguageCode: translation.detectedLanguageCode,
    glossaryApplied: Boolean(glossaryTranslations),
  }));
}

export async function translateText(
  config: RuntimeConfig["googleTranslate"],
  payload: {
    contents: string[];
    sourceLanguage: string;
    targetLanguage: string;
  },
): Promise<TranslationResult[]> {
  if (payload.contents.length === 0) {
    return [];
  }
  if (payload.sourceLanguage !== "auto") {
    if (isSameTranslationLanguage(payload.sourceLanguage, payload.targetLanguage)) {
      return payload.contents.map((translatedText) => ({
        translatedText,
        detectedLanguageCode: normalizeTranslationLanguage(payload.sourceLanguage),
        glossaryApplied: false,
      }));
    }

    const glossary = shouldUseGlossary(config, payload);
    try {
      return await callGoogleTranslateRequest(config, {
        ...payload,
        glossary,
      });
    } catch (error) {
      if (!glossary) {
        throw error;
      }
      console.warn("Google Translation glossary request failed; using base translation", {
        sourceLanguage: payload.sourceLanguage,
        targetLanguage: payload.targetLanguage,
        error: error instanceof Error ? error.message : String(error),
      });
      return callGoogleTranslateRequest(config, {
        ...payload,
        glossary: false,
      });
    }
  }

  const baseTranslations = await callGoogleTranslateRequest(config, {
    ...payload,
    glossary: false,
  });
  if (!shouldUseAutoDetectedGlossary(config, payload.targetLanguage)) {
    return baseTranslations;
  }

  const indexesBySourceLanguage = new Map<string, number[]>();
  baseTranslations.forEach((translation, index) => {
    const detected = translation.detectedLanguageCode;
    if (!detected || !hasTranslationLanguage(config.glossaryLanguages, detected)) {
      return;
    }
    const googleLanguage = normalizeTranslationLanguage(detected);
    if (isSameTranslationLanguage(googleLanguage, payload.targetLanguage)) {
      return;
    }
    indexesBySourceLanguage.set(googleLanguage, [
      ...(indexesBySourceLanguage.get(googleLanguage) ?? []),
      index,
    ]);
  });

  await Promise.all(
    [...indexesBySourceLanguage.entries()].map(async ([sourceLanguage, indexes]) => {
      try {
        const glossaryTranslations = await callGoogleTranslateRequest(config, {
          contents: indexes.map((index) => payload.contents[index] ?? ""),
          sourceLanguage,
          targetLanguage: payload.targetLanguage,
          glossary: true,
        });
        glossaryTranslations.forEach((translation, localIndex) => {
          const originalIndex = indexes[localIndex];
          if (originalIndex === undefined || !translation.translatedText) {
            return;
          }
          baseTranslations[originalIndex] = {
            ...translation,
            detectedLanguageCode: translation.detectedLanguageCode ?? sourceLanguage,
          };
        });
      } catch (error) {
        console.warn("Google Translation glossary request failed; using base translation", {
          sourceLanguage,
          targetLanguage: payload.targetLanguage,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return baseTranslations;
}
