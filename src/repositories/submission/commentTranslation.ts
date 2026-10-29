import { mapSubmission } from "./mapper";
import type { SubmissionRecord } from "./types";

export type PublicTranslationTarget = Pick<
  SubmissionRecord,
  | "id"
  | "kind"
  | "markerId"
  | "poiHash"
  | "poiType"
  | "snapshotId"
  | "userId"
  | "submitter"
  | "content"
>;

/** Public-only selection; an exact snapshot guard also gates completion delivery. */
export async function getPublicTranslationTarget(
  db: D1Database,
  submissionId: string,
  snapshotId?: string,
): Promise<PublicTranslationTarget | null> {
  const row = await db
    .prepare(`SELECT s.*, u.uid AS submitter_uid,
    u.uid_number AS user_uid_number, u.uid_suffix AS user_uid_suffix,
    u.role AS user_role, u.karma AS user_karma, u.nickname AS user_nickname, u.avt AS user_avt
    FROM ugc_public_submissions s JOIN users u ON u.uid=s.user_id
    WHERE s.id=?1 AND s.kind='comment' AND (?2 IS NULL OR s.snapshot_id=?2)`)
    .bind(submissionId, snapshotId ?? null)
    .first<Record<string, unknown>>();
  if (!row) {
    return null;
  }
  const {
    id,
    kind,
    markerId,
    poiHash,
    poiType,
    snapshotId: selectedSnapshotId,
    userId,
    submitter,
    content,
  } = mapSubmission(row);
  return {
    id,
    kind,
    markerId,
    poiHash,
    poiType,
    snapshotId: selectedSnapshotId,
    userId,
    submitter,
    content,
  };
}

export async function getVisibleCommentsByIds(
  db: D1Database,
  ids: string[],
): Promise<Array<Pick<SubmissionRecord, "id" | "snapshotId" | "content">>> {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 100);
  if (uniqueIds.length === 0) {
    return [];
  }

  const placeholders = uniqueIds.map((_, index) => `?${index + 1}`).join(", ");
  const result = await db
    .prepare(
      `SELECT s.id, s.snapshot_id AS snapshotId, s.content
       FROM ugc_public_submissions s
       WHERE s.id IN (${placeholders})
         AND s.kind = 'comment'`,
    )
    .bind(...uniqueIds)
    .all<Pick<SubmissionRecord, "id" | "snapshotId" | "content">>();

  return result.results ?? [];
}
