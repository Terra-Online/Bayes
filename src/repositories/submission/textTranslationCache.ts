import type { TextTranslationRecord } from "./types";

export async function getTextTranslation(
  db: D1Database,
  cacheKey: string
): Promise<TextTranslationRecord | null> {
  const row = await db
    .prepare(
      `SELECT *
       FROM ugc_text_translations
       WHERE cache_key = ?1
       LIMIT 1`
    )
    .bind(cacheKey)
    .first<Record<string, unknown>>();

  return row ? mapTextTranslation(row) : null;
}

export async function getTextTranslationByTarget(
  db: D1Database,
  payload: {
    textHash: string;
    targetLanguage: string;
    provider: string;
    glossaryVersion: string;
    glossaryKey: string;
  }
): Promise<TextTranslationRecord | null> {
  const row = await db
    .prepare(
      `SELECT *
       FROM ugc_text_translations
       WHERE text_hash = ?1
         AND target_language = ?2
         AND provider = ?3
         AND glossary_version = ?4
         AND glossary_key = ?5
       ORDER BY translated_at DESC
       LIMIT 1`
    )
    .bind(
      payload.textHash,
      payload.targetLanguage,
      payload.provider,
      payload.glossaryVersion,
      payload.glossaryKey
    )
    .first<Record<string, unknown>>();

  return row ? mapTextTranslation(row) : null;
}

export async function upsertTextTranslation(
  db: D1Database,
  payload: {
    cacheKey: string;
    textHash: string;
    flowVersion: string;
    sourceLanguage: string;
    detectedSourceLanguage?: string | null;
    targetLanguage: string;
    provider: string;
    glossaryVersion: string;
    glossaryKey: string;
    translatedContent: string;
    glossaryApplied: boolean;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ugc_text_translations (
         cache_key,
         text_hash,
         flow_version,
         source_language,
         detected_source_language,
         target_language,
         provider,
         glossary_version,
         glossary_key,
         translated_content,
         glossary_applied
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(cache_key)
       DO UPDATE SET text_hash = excluded.text_hash,
                     flow_version = excluded.flow_version,
                     source_language = excluded.source_language,
                     detected_source_language = excluded.detected_source_language,
                     target_language = excluded.target_language,
                     provider = excluded.provider,
                     glossary_version = excluded.glossary_version,
                     glossary_key = excluded.glossary_key,
                     translated_content = excluded.translated_content,
                     glossary_applied = excluded.glossary_applied,
                     translated_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP`
    )
    .bind(
      payload.cacheKey,
      payload.textHash,
      payload.flowVersion,
      payload.sourceLanguage,
      payload.detectedSourceLanguage ?? null,
      payload.targetLanguage,
      payload.provider,
      payload.glossaryVersion,
      payload.glossaryKey,
      payload.translatedContent,
      payload.glossaryApplied ? 1 : 0
    )
    .run();
}

function mapTextTranslation(row: Record<string, unknown>): TextTranslationRecord {
  return {
    cacheKey: String(row.cache_key),
    textHash: String(row.text_hash),
    flowVersion: String(row.flow_version),
    sourceLanguage: String(row.source_language),
    detectedSourceLanguage: row.detected_source_language === null || row.detected_source_language === undefined
      ? null
      : String(row.detected_source_language),
    targetLanguage: String(row.target_language),
    provider: String(row.provider),
    glossaryVersion: String(row.glossary_version ?? "g0"),
    glossaryKey: String(row.glossary_key ?? ""),
    translatedContent: String(row.translated_content ?? ""),
    glossaryApplied: Boolean(row.glossary_applied),
    translatedAt: String(row.translated_at),
    updatedAt: String(row.updated_at)
  };
}
