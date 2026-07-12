import { mapSubmission } from "./mapper";
import type { SubmissionRecord, SubmissionStatus } from "./types";

export async function getSubmissionById(db: D1Database, id: string): Promise<SubmissionRecord | null> {
  const row = await db
    .prepare(
      `SELECT
         s.*,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname
       FROM ugc_submissions s
       LEFT JOIN users u ON u.uid = s.user_id
       WHERE s.id = ?1
       LIMIT 1`
    )
    .bind(id)
    .first<Record<string, unknown>>();
  return row ? mapSubmission(row) : null;
}

export async function getPublicSubmissionByFilePath(db: D1Database, filePath: string): Promise<SubmissionRecord | null> {
  const row = await db
    .prepare(
      `SELECT *
       FROM ugc_submissions
       WHERE file_path = ?1
         AND kind = 'image'
         AND status IN ('active', 'flagged', 'remove_request')
       LIMIT 1`
    )
    .bind(filePath)
    .first<Record<string, unknown>>();

  return row ? mapSubmission(row) : null;
}

export async function getImageSubmissionByFilePath(db: D1Database, filePath: string): Promise<SubmissionRecord | null> {
  const row = await db
    .prepare(
      `SELECT *
       FROM ugc_submissions
       WHERE file_path = ?1
         AND kind = 'image'
       LIMIT 1`
    )
    .bind(filePath)
    .first<Record<string, unknown>>();

  return row ? mapSubmission(row) : null;
}

export async function updateSubmissionStatus(
  db: D1Database,
  payload: {
    id: string;
    status: SubmissionStatus;
    moderationNote?: string;
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE ugc_submissions
       SET status = ?2,
           moderation_note = COALESCE(?3, moderation_note),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?1`
    )
    .bind(payload.id, payload.status, payload.moderationNote ?? null)
    .run();
}

export async function updateSubmissionStatusForSnapshot(
  db: D1Database,
  payload: {
    id: string;
    snapshotId: string;
    fromStatus: SubmissionStatus;
    status: SubmissionStatus;
    moderationNote?: string;
  }
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE ugc_submissions
       SET status = ?3,
           moderation_note = COALESCE(?4, moderation_note),
           edit_original_content = CASE WHEN ?3 = 'active' THEN NULL ELSE edit_original_content END,
           edit_original_status = CASE WHEN ?3 = 'active' THEN NULL ELSE edit_original_status END,
           edit_original_snapshot_id = CASE WHEN ?3 = 'active' THEN NULL ELSE edit_original_snapshot_id END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?1
         AND snapshot_id = ?2
         AND status = ?5`
    )
    .bind(
      payload.id,
      payload.snapshotId,
      payload.status,
      payload.moderationNote ?? null,
      payload.fromStatus
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function updateCommentContentForModeration(
  db: D1Database,
  payload: {
    id: string;
    content: string;
    expectedSnapshotId: string;
    snapshotId: string;
    moderationNote: string;
  }
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE ugc_submissions
       SET content = ?2,
           edit_original_content = content,
           edit_original_status = status,
           edit_original_snapshot_id = snapshot_id,
           snapshot_id = ?3,
           status = 'pending_openai',
           moderation_note = ?4,
           moderation_queued_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?1
         AND kind = 'comment'
         AND snapshot_id = ?5
         AND status IN ('pending_openai', 'pending_audit', 'active', 'flagged', 'remove_request')`
    )
    .bind(
      payload.id,
      payload.content,
      payload.snapshotId,
      payload.moderationNote,
      payload.expectedSnapshotId
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function revertCommentEdit(
  db: D1Database,
  payload: {
    id: string;
    expectedSnapshotId: string;
    status: SubmissionStatus;
    moderationNote: string;
  }
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE ugc_submissions
       SET content = edit_original_content,
           edit_original_content = NULL,
           status = ?2,
           snapshot_id = edit_original_snapshot_id,
           edit_original_status = NULL,
           edit_original_snapshot_id = NULL,
           moderation_note = ?3,
           moderation_queued_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?1
         AND kind = 'comment'
         AND snapshot_id = ?4
         AND edit_original_content IS NOT NULL`
    )
    .bind(payload.id, payload.status, payload.moderationNote, payload.expectedSnapshotId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markSubmissionModerationQueued(
  db: D1Database,
  payload: {
    id: string;
    snapshotId: string;
    queuedAt: string;
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE ugc_submissions
       SET moderation_queued_at = ?3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?1
         AND snapshot_id = ?2
         AND status = 'pending_openai'`
    )
    .bind(payload.id, payload.snapshotId, payload.queuedAt)
    .run();
}

export async function getVisibleCommentsByIds(
  db: D1Database,
  ids: string[]
): Promise<SubmissionRecord[]> {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 100);
  if (uniqueIds.length === 0) {
    return [];
  }

  const placeholders = uniqueIds.map((_, index) => `?${index + 1}`).join(", ");
  const result = await db
    .prepare(
      `SELECT
         s.*,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname
       FROM ugc_submissions s
       LEFT JOIN users u ON u.uid = s.user_id
       WHERE s.id IN (${placeholders})
         AND s.kind = 'comment'
         AND s.status IN ('active', 'flagged', 'remove_request')`
    )
    .bind(...uniqueIds)
    .all<Record<string, unknown>>();

  return (result.results ?? []).map((row) => mapSubmission(row));
}
