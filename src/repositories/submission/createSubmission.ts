import { mapSubmission } from "./mapper";
import type { SubmissionKind, SubmissionRecord, SubmissionStatus } from "./types";

export async function createPendingSubmission(
  db: D1Database,
  payload: {
    id: string;
    markerId: string;
    poiHash: string;
    poiType: string;
    snapshotId: string;
    userId: string;
    content?: string;
    kind?: SubmissionKind;
    filePath?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    status?: SubmissionStatus;
    parentId?: string | null;
    commentDepth?: number;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ugc_submissions (
         id,
         poi_id,
         poi_hash,
         poi_type,
         snapshot_id,
         user_id,
         content,
         kind,
         file_path,
         status,
         mime_type,
         size_bytes,
         parent_id,
         comment_depth
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
    )
    .bind(
      payload.id,
      payload.markerId,
      payload.poiHash,
      payload.poiType,
      payload.snapshotId,
      payload.userId,
      payload.content ?? null,
      payload.kind ?? "image",
      payload.filePath ?? null,
      payload.status ?? "pending_openai",
      payload.mimeType ?? null,
      payload.sizeBytes ?? null,
      payload.parentId ?? null,
      payload.commentDepth ?? 0
    )
    .run();
}

export async function getPendingOpenAISubmissions(
  db: D1Database,
  limit = 50,
  queuedBefore?: string
): Promise<SubmissionRecord[]> {
  const queueFilter = queuedBefore
    ? "AND (moderation_queued_at IS NULL OR moderation_queued_at < ?2)"
    : "";
  const result = await db
    .prepare(
      `SELECT * FROM ugc_submissions
       WHERE status = 'pending_openai'
       ${queueFilter}
       ORDER BY created_at ASC
       LIMIT ?1`
    )
    .bind(...(queuedBefore ? [limit, queuedBefore] : [limit]))
    .all<Record<string, unknown>>();

  return (result.results ?? []).map((row) => mapSubmission(row));
}

export async function getPendingAuditSubmissions(db: D1Database, limit = 50): Promise<SubmissionRecord[]> {
  const result = await db
    .prepare(
      `SELECT * FROM ugc_submissions
       WHERE status = 'pending_audit'
       ORDER BY created_at ASC
       LIMIT ?1`
    )
    .bind(limit)
    .all<Record<string, unknown>>();

  return (result.results ?? []).map((row) => mapSubmission(row));
}
