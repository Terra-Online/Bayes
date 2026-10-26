import { getRuntimeConfig, type RuntimeConfig } from "@/lib/config";
import { sha256Hex } from "@/lib/crypto";
import { getJsonFromKv, putJsonToKv } from "@/lib/kvJson";
import { getVisibleCommentsByIds } from "@/repositories/submission/statusSubmission";
import {
  getTextTranslation,
  getTextTranslationByTarget,
  upsertTextTranslation,
} from "@/repositories/submission/textTranslationCache";
import type { TextTranslationRecord } from "@/repositories/submission/types";
import { shouldUseAutoDetectedGlossary, shouldUseGlossary } from "@/services/translation/glossary";
import {
  GOOGLE_TRANSLATION_PROVIDER,
  translateText,
} from "@/services/translation/googleTranslation";
import {
  hasTranslationLanguage,
  isSameTranslationLanguage,
  normalizeTranslationLanguage,
} from "@/services/translation/languages";
import type { Bindings } from "@/types/app";

import {
  buildCacheKeys,
  buildTargetDescriptor,
  normalizeTextForTranslationCache,
  type CacheDescriptor,
  type CacheKeys,
  type TargetDescriptor,
} from "./contract/cacheDescriptors";

const MAX_TRANSLATION_BATCH_SIZE = 100;
const SAME_LANGUAGE_ERROR = "Target language cannot be equal to source language.";
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

type TranslationOutcome = Omit<CommentTranslationItem, "commentId">;

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

type TextTranslationDetectionCacheRecord = {
  sourceLanguage: string;
  cacheKey: string;
  textHash: string;
  targetLanguage: string;
  provider: string;
  glossaryVersion: string;
  glossaryKey: string;
  translationGlossaryVersion?: string;
  createdAt: string;
};

function validateLanguage(config: RuntimeConfig["googleTranslate"], language: string): boolean {
  const trimmed = language.trim();
  if (!trimmed) {
    return false;
  }
  if (config.allowedLanguages.has(trimmed)) {
    return true;
  }

  return hasTranslationLanguage(config.allowedLanguages, trimmed);
}

function getGlossaryKey(
  config: RuntimeConfig["googleTranslate"],
  payload: {
    sourceLanguage: string;
    targetLanguage: string;
  },
): string {
  return shouldUseGlossary(config, payload) ? (config.glossary ?? "") : "";
}

function getLookupGlossaryKeys(
  config: RuntimeConfig["googleTranslate"],
  payload: {
    sourceLanguage: string;
    targetLanguage: string;
  },
): string[] {
  if (payload.sourceLanguage === "auto") {
    return shouldUseAutoDetectedGlossary(config, payload.targetLanguage)
      ? [config.glossary ?? "", ""]
      : [""];
  }

  const glossaryKey = getGlossaryKey(config, payload);
  return glossaryKey ? [glossaryKey, ""] : [""];
}

function getWriteGlossaryKey(
  config: RuntimeConfig["googleTranslate"],
  payload: {
    sourceLanguage: string;
    targetLanguage: string;
    glossaryApplied: boolean;
  },
): string {
  if (!payload.glossaryApplied) {
    return "";
  }

  return getGlossaryKey(config, payload);
}

async function getCachedTextTranslation(
  kv: KVNamespace | undefined,
  descriptor: CacheDescriptor,
): Promise<TextTranslationCacheRecord | null> {
  const { cacheKey, flowVersion } = buildCacheKeys({ kind: "translation", ...descriptor });
  let cached: unknown;
  try {
    cached = await getJsonFromKv<unknown>(kv, cacheKey);
  } catch (error) {
    console.warn("comment translation KV read failed", {
      cacheKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
    record.flowVersion !== flowVersion
  ) {
    return null;
  }

  return {
    translatedText: record.translatedText,
    sourceLanguage:
      typeof record.sourceLanguage === "string" ? record.sourceLanguage : descriptor.sourceLanguage,
    detectedSourceLanguage:
      typeof record.detectedSourceLanguage === "string" ? record.detectedSourceLanguage : undefined,
    targetLanguage: record.targetLanguage,
    provider: record.provider,
    glossaryApplied: record.glossaryApplied === true,
    glossaryKey: record.glossaryKey,
    glossaryVersion: record.glossaryVersion,
    flowVersion: record.flowVersion,
    translatedAt: typeof record.translatedAt === "string" ? record.translatedAt : "",
  };
}

async function getDetectedSourceFromKv(
  kv: KVNamespace | undefined,
  descriptor: TargetDescriptor,
): Promise<TextTranslationDetectionCacheRecord | null> {
  const { cacheKey } = buildCacheKeys({ kind: "detection", ...descriptor });
  let cached: unknown;
  try {
    cached = await getJsonFromKv<unknown>(kv, cacheKey);
  } catch (error) {
    console.warn("comment translation detection KV read failed", {
      cacheKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
    record.glossaryKey !== descriptor.glossaryKey ||
    (record.translationGlossaryVersion !== undefined &&
      (typeof record.translationGlossaryVersion !== "string" ||
        record.translationGlossaryVersion.length === 0))
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
    translationGlossaryVersion: record.translationGlossaryVersion,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
  };
}

async function putCachedTextTranslationToKv(
  kv: KVNamespace | undefined,
  descriptor: CacheDescriptor & CacheKeys,
  payload: {
    detectedSourceLanguage?: string;
    translatedText: string;
    glossaryApplied: boolean;
    translatedAt?: string;
  },
): Promise<void> {
  const record: TextTranslationCacheRecord = {
    translatedText: payload.translatedText,
    sourceLanguage: descriptor.sourceLanguage,
    detectedSourceLanguage: payload.detectedSourceLanguage
      ? normalizeTranslationLanguage(payload.detectedSourceLanguage)
      : undefined,
    targetLanguage: descriptor.targetLanguage,
    provider: GOOGLE_TRANSLATION_PROVIDER,
    glossaryApplied: payload.glossaryApplied,
    glossaryKey: descriptor.glossaryKey,
    glossaryVersion: descriptor.glossaryVersion,
    flowVersion: descriptor.flowVersion,
    translatedAt: payload.translatedAt ?? new Date().toISOString(),
  };
  await putJsonToKv(kv, descriptor.cacheKey, record);
}

async function putDetectedSourceToKv(
  kv: KVNamespace | undefined,
  targetDescriptor: TargetDescriptor,
  translationDescriptor: CacheDescriptor & CacheKeys,
): Promise<void> {
  const { cacheKey } = buildCacheKeys({ kind: "detection", ...targetDescriptor });
  const record: TextTranslationDetectionCacheRecord = {
    sourceLanguage: translationDescriptor.sourceLanguage,
    cacheKey: translationDescriptor.cacheKey,
    textHash: targetDescriptor.textHash,
    targetLanguage: targetDescriptor.targetLanguage,
    provider: GOOGLE_TRANSLATION_PROVIDER,
    glossaryVersion: targetDescriptor.glossaryVersion,
    glossaryKey: targetDescriptor.glossaryKey,
    translationGlossaryVersion: translationDescriptor.glossaryVersion,
    createdAt: new Date().toISOString(),
  };
  await putJsonToKv(kv, cacheKey, record);
}

async function settleTranslationKvWrites(label: string, writes: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(writes);
  results.forEach((result) => {
    if (result.status === "rejected") {
      console.warn(`comment translation ${label} KV write failed`, {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
}

async function putCachedTextTranslationToD1(
  db: D1Database,
  descriptor: CacheDescriptor & CacheKeys,
  payload: {
    detectedSourceLanguage?: string;
    translatedText: string;
    glossaryApplied: boolean;
  },
): Promise<void> {
  await upsertTextTranslation(db, {
    cacheKey: descriptor.cacheKey,
    textHash: descriptor.textHash,
    flowVersion: descriptor.flowVersion,
    sourceLanguage: descriptor.sourceLanguage,
    detectedSourceLanguage: payload.detectedSourceLanguage
      ? normalizeTranslationLanguage(payload.detectedSourceLanguage)
      : null,
    targetLanguage: descriptor.targetLanguage,
    provider: GOOGLE_TRANSLATION_PROVIDER,
    glossaryVersion: descriptor.glossaryVersion,
    glossaryKey: descriptor.glossaryKey,
    translatedContent: payload.translatedText,
    glossaryApplied: payload.glossaryApplied,
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
    translatedAt: record.translatedAt,
  };
}

async function getCachedOrStoredTextTranslationByDescriptor(
  env: Bindings,
  descriptor: CacheDescriptor,
): Promise<TextTranslationCacheRecord | null> {
  const textCached = await getCachedTextTranslation(env.OEM_KV, descriptor);
  if (textCached?.translatedText) {
    return textCached;
  }

  // A glossary revision applies to new translations; it must not discard existing ones.
  const { cacheKey } = buildCacheKeys({ kind: "translation", ...descriptor });
  const exactTranslation = await getTextTranslation(env.DB, cacheKey);
  const storedTextTranslation =
    exactTranslation?.translatedContent.trim() &&
    exactTranslation.provider === GOOGLE_TRANSLATION_PROVIDER &&
    exactTranslation.glossaryKey === descriptor.glossaryKey
      ? exactTranslation
      : await getTextTranslationByTarget(env.DB, {
          textHash: descriptor.textHash,
          sourceLanguage: descriptor.sourceLanguage,
          targetLanguage: descriptor.targetLanguage,
          provider: GOOGLE_TRANSLATION_PROVIDER,
          glossaryVersion: descriptor.glossaryVersion,
          glossaryKey: descriptor.glossaryKey,
        });
  if (!storedTextTranslation?.translatedContent) {
    return null;
  }

  const record = cacheRecordFromD1(storedTextTranslation);
  await settleTranslationKvWrites("repair", [
    putCachedTextTranslationToKv(env.OEM_KV, storedTextTranslation, {
      detectedSourceLanguage: record.detectedSourceLanguage,
      translatedText: record.translatedText,
      glossaryApplied: record.glossaryApplied,
      translatedAt: record.translatedAt,
    }),
  ]);
  return record;
}

async function getCachedOrStoredAutoTextTranslation(
  env: Bindings,
  targetDescriptor: TargetDescriptor,
): Promise<TextTranslationCacheRecord | null> {
  const detectedSource = await getDetectedSourceFromKv(env.OEM_KV, targetDescriptor);
  if (detectedSource) {
    const descriptor: CacheDescriptor = {
      ...targetDescriptor,
      sourceLanguage: normalizeTranslationLanguage(detectedSource.sourceLanguage),
    };
    const record = await getCachedTextTranslation(env.OEM_KV, descriptor);
    if (record?.translatedText) {
      return record;
    }

    if (
      detectedSource.translationGlossaryVersion &&
      detectedSource.translationGlossaryVersion !== targetDescriptor.glossaryVersion
    ) {
      const historicalDescriptor: CacheDescriptor = {
        ...descriptor,
        glossaryVersion: detectedSource.translationGlossaryVersion,
      };
      const { cacheKey } = buildCacheKeys({ kind: "translation", ...historicalDescriptor });
      if (cacheKey === detectedSource.cacheKey) {
        const historical = await getCachedTextTranslation(env.OEM_KV, historicalDescriptor);
        if (historical?.translatedText) {
          return historical;
        }
      }
    }
  }

  const storedTextTranslation = await getTextTranslationByTarget(env.DB, {
    textHash: targetDescriptor.textHash,
    targetLanguage: targetDescriptor.targetLanguage,
    provider: GOOGLE_TRANSLATION_PROVIDER,
    glossaryVersion: targetDescriptor.glossaryVersion,
    glossaryKey: targetDescriptor.glossaryKey,
  });
  if (!storedTextTranslation?.translatedContent) {
    return null;
  }

  const record = cacheRecordFromD1(storedTextTranslation);
  await settleTranslationKvWrites("repair", [
    putCachedTextTranslationToKv(env.OEM_KV, storedTextTranslation, {
      detectedSourceLanguage: record.detectedSourceLanguage,
      translatedText: record.translatedText,
      glossaryApplied: record.glossaryApplied,
      translatedAt: record.translatedAt,
    }),
    putDetectedSourceToKv(env.OEM_KV, targetDescriptor, storedTextTranslation),
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
    textHash: string;
    translatedText: string;
    glossaryApplied: boolean;
  },
): Promise<void> {
  const sourceLanguage =
    payload.sourceLanguage === "auto"
      ? (payload.detectedSourceLanguage ?? "auto")
      : payload.sourceLanguage;

  if (isSameTranslationLanguage(sourceLanguage, payload.targetLanguage)) {
    return;
  }

  const glossaryKey = getWriteGlossaryKey(config, {
    sourceLanguage,
    targetLanguage: payload.targetLanguage,
    glossaryApplied: payload.glossaryApplied,
  });
  const targetDescriptor = buildTargetDescriptor({
    targetLanguage: payload.targetLanguage,
    glossaryKey,
    glossaryVersion: config.glossaryVersion,
    textHash: payload.textHash,
  });
  const descriptor: CacheDescriptor = {
    ...targetDescriptor,
    sourceLanguage: normalizeTranslationLanguage(sourceLanguage),
  };
  const storageIdentity = {
    ...descriptor,
    ...buildCacheKeys({ kind: "translation", ...descriptor }),
  };

  await putCachedTextTranslationToD1(env.DB, storageIdentity, {
    detectedSourceLanguage: payload.detectedSourceLanguage,
    translatedText: payload.translatedText,
    glossaryApplied: payload.glossaryApplied,
  });

  await settleTranslationKvWrites("store", [
    putCachedTextTranslationToKv(env.OEM_KV, storageIdentity, {
      detectedSourceLanguage: payload.detectedSourceLanguage,
      translatedText: payload.translatedText,
      glossaryApplied: payload.glossaryApplied,
    }),
    payload.sourceLanguage === "auto"
      ? putDetectedSourceToKv(env.OEM_KV, targetDescriptor, storageIdentity)
      : Promise.resolve(),
  ]);
}

function normalizeSourceLanguage(sourceLanguage: string | undefined): string {
  return sourceLanguage?.trim() || "auto";
}

function outcomeFromCachedTextTranslation(
  targetLanguage: string,
  record: TextTranslationCacheRecord,
): TranslationOutcome {
  const sourceLanguage = record.detectedSourceLanguage ?? record.sourceLanguage;
  if (isSameTranslationLanguage(sourceLanguage, targetLanguage)) {
    return {
      sourceLanguage,
      targetLanguage,
      provider: record.provider,
      glossaryApplied: false,
      cached: true,
      error: SAME_LANGUAGE_ERROR,
    };
  }

  return {
    translatedContent: record.translatedText,
    sourceLanguage,
    targetLanguage,
    provider: record.provider,
    glossaryApplied: record.glossaryApplied,
    cached: true,
  };
}

type CacheLookup = {
  textHash: string;
  cached: TextTranslationCacheRecord | null;
};

async function lookupCachedTexts(
  env: Bindings,
  config: RuntimeConfig["googleTranslate"],
  payload: {
    normalizedTexts: string[];
    sourceLanguage: string;
    targetLanguage: string;
  },
): Promise<CacheLookup[]> {
  const lookupGlossaryKeys = getLookupGlossaryKeys(config, payload);
  // Chain the mapped lookups to retain sequential DB/KV access.
  let previousLookup: Promise<unknown> = Promise.resolve();
  return Promise.all(
    payload.normalizedTexts.map((normalizedText) => {
      const lookup = previousLookup.then(async (): Promise<CacheLookup> => {
        const textHash = await sha256Hex(normalizedText);
        let cached: TextTranslationCacheRecord | null = null;
        for (const glossaryKey of lookupGlossaryKeys) {
          const target = buildTargetDescriptor({
            targetLanguage: payload.targetLanguage,
            glossaryKey,
            glossaryVersion: config.glossaryVersion,
            textHash,
          });
          cached =
            payload.sourceLanguage === "auto"
              ? await getCachedOrStoredAutoTextTranslation(env, target)
              : await getCachedOrStoredTextTranslationByDescriptor(env, {
                  ...target,
                  sourceLanguage: normalizeTranslationLanguage(payload.sourceLanguage),
                });
          if (cached) {
            break;
          }
        }
        return { textHash, cached };
      });
      previousLookup = lookup;
      return lookup;
    }),
  );
}

async function translateAndCacheTexts(
  env: Bindings,
  config: RuntimeConfig["googleTranslate"],
  payload: {
    texts: Array<{ content: string; textHash: string }>;
    sourceLanguage: string;
    targetLanguage: string;
  },
): Promise<TranslationOutcome[]> {
  const defaults = {
    targetLanguage: payload.targetLanguage,
    provider: GOOGLE_TRANSLATION_PROVIDER,
    glossaryApplied: false,
    cached: false,
  };
  try {
    const translated = await translateText(config, {
      contents: payload.texts.map(({ content }) => content),
      sourceLanguage: payload.sourceLanguage,
      targetLanguage: payload.targetLanguage,
    });
    return await Promise.all(
      payload.texts.map(async ({ textHash }, index): Promise<TranslationOutcome> => {
        const translation = translated[index];
        if (!translation?.translatedText) {
          return { ...defaults, error: "TRANSLATION_EMPTY" };
        }

        try {
          await putCachedTextTranslation(env, config, {
            sourceLanguage: payload.sourceLanguage,
            detectedSourceLanguage: translation.detectedLanguageCode,
            targetLanguage: payload.targetLanguage,
            textHash,
            translatedText: translation.translatedText,
            glossaryApplied: translation.glossaryApplied,
          });
        } catch (error) {
          return {
            ...defaults,
            error: error instanceof Error ? error.message : "Translation persistence failed.",
          };
        }

        const resolvedSource = translation.detectedLanguageCode ?? payload.sourceLanguage;
        return isSameTranslationLanguage(resolvedSource, payload.targetLanguage)
          ? { ...defaults, sourceLanguage: resolvedSource, error: SAME_LANGUAGE_ERROR }
          : {
              ...defaults,
              sourceLanguage: resolvedSource,
              translatedContent: translation.translatedText,
              glossaryApplied: translation.glossaryApplied,
            };
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Translation failed.";
    return payload.texts.map(() => ({ ...defaults, error: message }));
  }
}

export async function translateVisibleComments(
  env: Bindings,
  payload: {
    commentIds: string[];
    cachedOnly?: boolean;
    sourceLanguage?: string;
    targetLanguage: string;
  },
): Promise<{ items: CommentTranslationItem[] }> {
  const config = getRuntimeConfig(env).googleTranslate;
  const commentIds = [...new Set(payload.commentIds.map((id) => id.trim()).filter(Boolean))].slice(
    0,
    MAX_TRANSLATION_BATCH_SIZE,
  );
  const targetLanguage = payload.targetLanguage.trim();
  const sourceLanguage = normalizeSourceLanguage(payload.sourceLanguage);

  const defaults = {
    targetLanguage,
    provider: GOOGLE_TRANSLATION_PROVIDER,
    glossaryApplied: false,
    cached: false,
  };

  if (
    !validateLanguage(config, targetLanguage) ||
    (sourceLanguage !== "auto" && !validateLanguage(config, sourceLanguage))
  ) {
    return {
      items: commentIds.map((commentId) => ({
        ...defaults,
        commentId,
        error: "LANGUAGE_NOT_ALLOWED",
      })),
    };
  }

  const comments = await getVisibleCommentsByIds(env.DB, commentIds);
  type VisibleComment = (typeof comments)[number];
  type Group = { content: string; normalizedText: string };

  const commentById = new Map<string, VisibleComment>(
    comments.map((comment) => [comment.id, comment]),
  );
  const groupByText = new Map<string, Group>();
  // Input order selects the original text shared by each normalized-text group.
  const groupById = new Map<string, Group | undefined>(
    commentIds.map((id): [string, Group | undefined] => {
      const comment = commentById.get(id);
      if (!comment) {
        return [id, undefined];
      }
      const content = comment.content ?? "";
      const normalizedText = normalizeTextForTranslationCache(content);
      let group = groupByText.get(normalizedText);
      if (!group) {
        group = { content, normalizedText };
        groupByText.set(normalizedText, group);
      }
      return [id, group];
    }),
  );

  const groups = [...groupByText.values()];
  const lookups = await lookupCachedTexts(env, config, {
    normalizedTexts: groups.map(({ normalizedText }) => normalizedText),
    sourceLanguage,
    targetLanguage,
  });
  const lookupByGroup = new Map<Group, CacheLookup>(
    groups.map((group, index) => [group, lookups[index]!]),
  );
  const cacheOutcomeByGroup = new Map<Group, TranslationOutcome>(
    [...lookupByGroup].flatMap(([group, { cached }]): Array<[Group, TranslationOutcome]> => {
      if (cached) {
        return [[group, outcomeFromCachedTextTranslation(targetLanguage, cached)]];
      }
      return payload.cachedOnly ? [[group, { ...defaults, error: "TRANSLATION_CACHE_MISS" }]] : [];
    }),
  );
  const pending = [...lookupByGroup].filter(([, { cached }]) => !cached && !payload.cachedOnly);
  const translated = await translateAndCacheTexts(env, config, {
    texts: pending.map(([group, { textHash }]) => ({ content: group.content, textHash })),
    sourceLanguage,
    targetLanguage,
  });
  const translationOutcomeByGroup = new Map<Group, TranslationOutcome>(
    pending.map(([group], index) => [group, translated[index]!]),
  );
  const outcomeByGroup = new Map<Group, TranslationOutcome>([
    ...cacheOutcomeByGroup,
    ...translationOutcomeByGroup,
  ]);
  return {
    items: [...groupById].map(([commentId, group]) => ({
      // Every visible group has either a cache outcome or a translation outcome.
      ...(group ? outcomeByGroup.get(group)! : { ...defaults, error: "COMMENT_NOT_TRANSLATABLE" }),
      commentId,
    })),
  };
}
