import type { RuntimeConfig } from "@/lib/config";

import { hasTranslationLanguage } from "./languages";

export function shouldUseGlossary(
  config: RuntimeConfig["googleTranslate"],
  payload: {
    sourceLanguage: string;
    targetLanguage: string;
  },
): boolean {
  if (!config.glossary) {
    return false;
  }

  if (!hasTranslationLanguage(config.glossaryLanguages, payload.targetLanguage)) {
    return false;
  }

  return (
    payload.sourceLanguage !== "auto" &&
    hasTranslationLanguage(config.glossaryLanguages, payload.sourceLanguage)
  );
}

export function shouldUseAutoDetectedGlossary(
  config: RuntimeConfig["googleTranslate"],
  targetLanguage: string,
): boolean {
  return (
    Boolean(config.glossary) && hasTranslationLanguage(config.glossaryLanguages, targetLanguage)
  );
}
