import type { SubmissionKind, SubmissionStatus } from "./types";

export type SnapshotReviewStatus =
  | "pending_openai"
  | "pending_audit"
  | "approved"
  | "rejected"
  | "unknown";

/** Content and snapshotId always describe the same immutable version. */
export interface PublicSnapshot {
  id: string;
  kind: SubmissionKind;
  userId: string;
  markerId: string;
  poiHash: string;
  poiType: string;
  parentId: string | null;
  commentDepth: number;
  snapshotId: string;
  revision: number;
  content: string | null;
  filePath: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  reviewStatus: SnapshotReviewStatus;
  status: SubmissionStatus;
  flagCount: number;
  createdAt: string;
  snapshotCreatedAt: string;
}

export interface OwnerSnapshot extends PublicSnapshot {
  /** Archive access does not grant edit permission. */
  canEdit: boolean;
  authorDeletedAt: string | null;
  adminDeletedAt: string | null;
}

type SnapshotRow = PublicSnapshot & {
  canEdit: number;
  authorDeletedAt: string | null;
  adminDeletedAt: string | null;
};

// Both reads select content and identity in the same SQL statement. No caller
// has to reconstruct fallback selection or authorize access to hidden content.
const selection = `SELECT
  s.id, s.kind, s.user_id AS userId, s.poi_id AS markerId,
  s.poi_hash AS poiHash, s.poi_type AS poiType, s.parent_id AS parentId,
  s.comment_depth AS commentDepth, s.created_at AS createdAt,
  r.id AS snapshotId, r.revision, r.content, r.file_path AS filePath,
  r.mime_type AS mimeType, r.size_bytes AS sizeBytes,
  r.created_at AS snapshotCreatedAt, r.review_status AS reviewStatus,
  s.author_deleted_at AS authorDeletedAt, s.admin_deleted_at AS adminDeletedAt,
  v.lifecycle_allows_edit AS canEdit,
  (SELECT COUNT(*) FROM ugc_submission_flags g
    WHERE g.submission_id = s.id AND g.active = 1) AS flagCount,
  CASE
    WHEN s.author_deleted_at IS NOT NULL OR s.admin_deleted_at IS NOT NULL
      OR r.review_status IN ('unknown', 'rejected') THEN 'stale'
    WHEN r.review_status IN ('pending_openai', 'pending_audit') THEN r.review_status
    WHEN EXISTS (SELECT 1 FROM ugc_submission_flags g
      WHERE g.submission_id = s.id AND g.active = 1) THEN 'flagged'
    ELSE 'active'
  END AS status
FROM ugc_submissions s
JOIN ugc_submission_visibility v ON v.submission_id = s.id
JOIN ugc_snapshots r ON r.submission_id = s.id`;

/** Public selection never grants owner privileges, including to authenticated authors. */
export async function getPublicSnapshot(
  db: D1Database,
  id: string,
): Promise<PublicSnapshot | null> {
  const row = await db
    .prepare(`${selection}
    AND r.id = v.public_snapshot_id WHERE s.id = ?`)
    .bind(id)
    .first<SnapshotRow>();
  if (!row) {
    return null;
  }
  const {
    canEdit: _canEdit,
    authorDeletedAt: _author,
    adminDeletedAt: _admin,
    ...publicSnapshot
  } = row;
  return publicSnapshot;
}

/** ownerUserId must come from authentication, never a client supplied identity. */
export async function getOwnerSnapshot(
  db: D1Database,
  input: { id: string; ownerUserId: string },
): Promise<OwnerSnapshot | null> {
  const row = await db
    .prepare(`${selection}
    AND r.id = v.frontier_snapshot_id WHERE s.id = ? AND s.user_id = ?`)
    .bind(input.id, input.ownerUserId)
    .first<SnapshotRow>();
  return row ? { ...row, canEdit: Boolean(row.canEdit) } : null;
}
