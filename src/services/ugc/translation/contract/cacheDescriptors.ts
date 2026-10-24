import { normalizeTranslationLanguage } from "@/services/translation/languages";

export type TargetDescriptor = {
  textHash: string;
  targetLanguage: string;
  glossaryKey: string;
  glossaryVersion: string;
};

export type CacheDescriptor = TargetDescriptor & {
  sourceLanguage: string;
};

export type CacheKeys = {
  cacheKey: string;
  flowVersion: string;
};

export function normalizeTextForTranslationCache(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ");
}

export function buildTargetDescriptor(input: TargetDescriptor): TargetDescriptor {
  return {
    ...input,
    targetLanguage: normalizeTranslationLanguage(input.targetLanguage),
    glossaryVersion: input.glossaryKey ? input.glossaryVersion : "g0",
  };
}

// Descriptors contain identity data only. Derive the persisted key format at
// storage access, keeping the existing D1 and KV strings compatible.
export function buildCacheKeys(
  input: (TargetDescriptor & { kind: "detection" }) | (CacheDescriptor & { kind: "translation" }),
): CacheKeys {
  const flowVersion = [
    "translate",
    "v1",
    input.glossaryVersion,
    "google-v3",
    input.kind === "detection" ? "detect" : input.sourceLanguage,
    input.targetLanguage,
  ].join(":");

  return {
    cacheKey: `${flowVersion}:${input.textHash}`,
    flowVersion,
  };
}
