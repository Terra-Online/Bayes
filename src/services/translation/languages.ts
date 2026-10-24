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
  "tr-TR": "tr",
};
const GOOGLE_LANGUAGE_BY_LOWERCASE_LOCALE = Object.fromEntries(
  Object.entries(GOOGLE_LANGUAGE_BY_LOCALE).map(([locale, language]) => [
    locale.toLowerCase(),
    language,
  ]),
);

export function normalizeTranslationLanguage(language: string): string {
  const trimmed = language.trim();
  return (
    GOOGLE_LANGUAGE_BY_LOCALE[trimmed] ??
    GOOGLE_LANGUAGE_BY_LOWERCASE_LOCALE[trimmed.toLowerCase()] ??
    trimmed
  );
}

export function isSameTranslationLanguage(
  sourceLanguage: string | undefined,
  targetLanguage: string,
): boolean {
  if (!sourceLanguage?.trim()) {
    return false;
  }
  return (
    normalizeTranslationLanguage(sourceLanguage).toLowerCase() ===
    normalizeTranslationLanguage(targetLanguage).toLowerCase()
  );
}

export function hasTranslationLanguage(languages: Set<string>, language: string): boolean {
  const googleLanguage = normalizeTranslationLanguage(language);
  for (const configuredLanguage of languages) {
    if (normalizeTranslationLanguage(configuredLanguage) === googleLanguage) {
      return true;
    }
  }
  return false;
}
