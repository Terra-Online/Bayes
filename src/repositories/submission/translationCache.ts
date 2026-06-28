import { mapCommentTranslation } from "./mapper";
import type { CommentTranslationRecord } from "./types";

export async function getCommentTranslations(
  db: D1Database,
  payload: {
    commentIds: string[];
    sourceLanguage: string;
    targetLanguage: string;
    glossaryKey: string;
    sourceHashes: Map<string, string>;
  }
): Promise<CommentTranslationRecord[]> {
  const commentIds = [...new Set(payload.commentIds.map((id) => id.trim()).filter(Boolean))].slice(0, 100);
  if (commentIds.length === 0) {
    return [];
  }

  const hashPlaceholders = commentIds.map((_, index) => `?${index + 4}`).join(", ");
  const idPlaceholderOffset = commentIds.length + 4;
  const idPlaceholders = commentIds.map((_, index) => `?${idPlaceholderOffset + index}`).join(", ");
  const result = await db
    .prepare(
      `SELECT *
       FROM ugc_comment_translations
       WHERE source_language = ?1
         AND target_language = ?2
         AND glossary_key = ?3
         AND source_hash IN (${hashPlaceholders})
         AND comment_id IN (${idPlaceholders})`
    )
    .bind(
      payload.sourceLanguage,
      payload.targetLanguage,
      payload.glossaryKey,
      ...commentIds.map((id) => payload.sourceHashes.get(id) ?? ""),
      ...commentIds
    )
    .all<Record<string, unknown>>();

  return (result.results ?? []).map((row) => mapCommentTranslation(row));
}

export async function upsertCommentTranslation(
  db: D1Database,
  payload: {
    commentId: string;
    sourceLanguage: string;
    detectedSourceLanguage?: string | null;
    targetLanguage: string;
    glossaryKey: string;
    sourceHash: string;
    translatedContent: string;
    provider: string;
    glossaryApplied: boolean;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ugc_comment_translations (
         comment_id,
         source_language,
         detected_source_language,
         target_language,
         glossary_key,
         source_hash,
         translated_content,
         provider,
         glossary_applied
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(comment_id, source_language, target_language, glossary_key, source_hash)
       DO UPDATE SET detected_source_language = excluded.detected_source_language,
                     translated_content = excluded.translated_content,
                     provider = excluded.provider,
                     glossary_applied = excluded.glossary_applied,
                     updated_at = CURRENT_TIMESTAMP`
    )
    .bind(
      payload.commentId,
      payload.sourceLanguage,
      payload.detectedSourceLanguage ?? null,
      payload.targetLanguage,
      payload.glossaryKey,
      payload.sourceHash,
      payload.translatedContent,
      payload.provider,
      payload.glossaryApplied ? 1 : 0
    )
    .run();
}
