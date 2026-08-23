export interface TranslationReport {
  generatedAt: string;
  totalTranslations: number;
  sourceTexts: number;
  glossaryTranslations: number;
  firstTranslationDate: string | null;
  lastTranslationDate: string | null;
  daily: Array<{ date: string; count: number }>;
  sources: Array<{ language: string; count: number }>;
  targets: Array<{ language: string; count: number }>;
  flows: Array<{ sourceLanguage: string; targetLanguage: string; count: number }>;
}

type CountValue = number | string | null | undefined;

function toCount(value: CountValue): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

const RESOLVED_SOURCE_LANGUAGE = `COALESCE(
  NULLIF(TRIM(detected_source_language), ''),
  NULLIF(TRIM(source_language), ''),
  'unknown'
)`;

export async function getTranslationReport(db: D1Database): Promise<TranslationReport> {
  const [summary, dailyRows, sourceRows, targetRows, flowRows] = await Promise.all([
    db
      .prepare(
        `SELECT
           COUNT(*) AS total_translations,
           COUNT(DISTINCT text_hash) AS source_texts,
           SUM(CASE WHEN glossary_applied = 1 THEN 1 ELSE 0 END) AS glossary_translations,
           MIN(date(translated_at)) AS first_translation_date,
           MAX(date(translated_at)) AS last_translation_date
         FROM ugc_text_translations`,
      )
      .first<{
        total_translations: CountValue;
        source_texts: CountValue;
        glossary_translations: CountValue;
        first_translation_date: string | null;
        last_translation_date: string | null;
      }>(),
    db
      .prepare(
        `SELECT date(translated_at) AS translation_date, COUNT(*) AS count
         FROM ugc_text_translations
         WHERE date(translated_at) IS NOT NULL
         GROUP BY date(translated_at)
         ORDER BY translation_date ASC`,
      )
      .all<{ translation_date: string; count: CountValue }>(),
    db
      .prepare(
        `SELECT ${RESOLVED_SOURCE_LANGUAGE} AS language, COUNT(*) AS count
         FROM ugc_text_translations
         GROUP BY ${RESOLVED_SOURCE_LANGUAGE}
         ORDER BY count DESC, language ASC`,
      )
      .all<{ language: string; count: CountValue }>(),
    db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(target_language), ''), 'unknown') AS language, COUNT(*) AS count
         FROM ugc_text_translations
         GROUP BY COALESCE(NULLIF(TRIM(target_language), ''), 'unknown')
         ORDER BY count DESC, language ASC`,
      )
      .all<{ language: string; count: CountValue }>(),
    db
      .prepare(
        `SELECT
           ${RESOLVED_SOURCE_LANGUAGE} AS source_language,
           COALESCE(NULLIF(TRIM(target_language), ''), 'unknown') AS target_language,
           COUNT(*) AS count
         FROM ugc_text_translations
         GROUP BY
           ${RESOLVED_SOURCE_LANGUAGE},
           COALESCE(NULLIF(TRIM(target_language), ''), 'unknown')
         ORDER BY count DESC, source_language ASC, target_language ASC`,
      )
      .all<{ source_language: string; target_language: string; count: CountValue }>(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    totalTranslations: toCount(summary?.total_translations),
    sourceTexts: toCount(summary?.source_texts),
    glossaryTranslations: toCount(summary?.glossary_translations),
    firstTranslationDate: summary?.first_translation_date ?? null,
    lastTranslationDate: summary?.last_translation_date ?? null,
    daily: (dailyRows.results ?? []).map((row) => ({
      date: String(row.translation_date),
      count: toCount(row.count),
    })),
    sources: (sourceRows.results ?? []).map((row) => ({
      language: String(row.language),
      count: toCount(row.count),
    })),
    targets: (targetRows.results ?? []).map((row) => ({
      language: String(row.language),
      count: toCount(row.count),
    })),
    flows: (flowRows.results ?? []).map((row) => ({
      sourceLanguage: String(row.source_language),
      targetLanguage: String(row.target_language),
      count: toCount(row.count),
    })),
  };
}
