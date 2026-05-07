import { formatPublicUid } from "./users";

export interface SubmissionRecord {
  id: string;
  markerId: string;
  poiHash: string;
  poiType: string;
  snapshotId: string;
  userId: string;
  content: string | null;
  filePath: string;
  status: SubmissionStatus;
  moderationNote: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  submitter: SubmissionSubmitter | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubmissionSubmitter {
  uid: string;
  uidNumber: number | null;
  publicUid: string | null;
  role: string | null;
  karma: number | null;
  nickname: string | null;
}

export type SubmissionStatus =
  | "pending_openai"
  | "pending_audit"
  | "active"
  | "flagged"
  | "pending_removal"
  | "stale";

export interface PublicSubmissionImage {
  id: string;
  markerId: string;
  poiHash: string;
  poiType: string;
  snapshotId: string;
  url: string;
  content: string | null;
  createdAt: string;
}

function mapSubmission(row: Record<string, unknown>): SubmissionRecord {
  const uidNumber = row.user_uid_number === null || row.user_uid_number === undefined
    ? null
    : Number(row.user_uid_number);
  const uidSuffix = row.user_uid_suffix === null || row.user_uid_suffix === undefined
    ? null
    : String(row.user_uid_suffix);
  const submitterUid = row.submitter_uid === null || row.submitter_uid === undefined
    ? null
    : String(row.submitter_uid);

  return {
    id: String(row.id),
    markerId: String(row.poi_id),
    poiHash: String(row.poi_hash),
    poiType: String(row.poi_type),
    snapshotId: String(row.snapshot_id),
    userId: String(row.user_id),
    content: row.content === null ? null : String(row.content ?? ""),
    filePath: String(row.file_path),
    status: mapStatus(row.status),
    moderationNote: row.moderation_note === null ? null : String(row.moderation_note ?? ""),
    mimeType: row.mime_type === null || row.mime_type === undefined ? null : String(row.mime_type),
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    submitter: submitterUid
      ? {
          uid: submitterUid,
          uidNumber: uidNumber !== null && Number.isFinite(uidNumber) ? uidNumber : null,
          publicUid: uidNumber !== null && Number.isFinite(uidNumber) && uidSuffix
            ? formatPublicUid(uidNumber, uidSuffix)
            : null,
          role: row.user_role === null || row.user_role === undefined ? null : String(row.user_role),
          karma: row.user_karma === null || row.user_karma === undefined ? null : Number(row.user_karma),
          nickname: row.user_nickname === null || row.user_nickname === undefined ? null : String(row.user_nickname)
        }
      : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

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
    filePath: string;
    mimeType: string;
    sizeBytes: number;
    status?: SubmissionStatus;
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
         file_path,
         status,
         mime_type,
         size_bytes
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
    )
    .bind(
      payload.id,
      payload.markerId,
      payload.poiHash,
      payload.poiType,
      payload.snapshotId,
      payload.userId,
      payload.content ?? null,
      payload.filePath,
      payload.status ?? "pending_audit",
      payload.mimeType,
      payload.sizeBytes
    )
    .run();
}

export async function getPendingOpenAISubmissions(db: D1Database, limit = 50): Promise<SubmissionRecord[]> {
  const result = await db
    .prepare(
      `SELECT * FROM ugc_submissions
       WHERE status = 'pending_openai'
       ORDER BY created_at ASC
       LIMIT ?1`
    )
    .bind(limit)
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

export async function getReviewSubmissions(
  db: D1Database,
  payload: {
    statuses?: SubmissionStatus[];
    limit?: number;
  } = {}
): Promise<SubmissionRecord[]> {
  const statuses = payload.statuses?.length ? payload.statuses : ALL_STATUSES;
  const placeholders = statuses.map((_, index) => `?${index + 1}`).join(", ");
  const limit = Math.min(Math.max(payload.limit ?? 100, 1), 500);
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
       WHERE s.status IN (${placeholders})
       ORDER BY
         CASE s.status
           WHEN 'pending_openai' THEN 0
           WHEN 'pending_audit' THEN 0
           WHEN 'flagged' THEN 1
           WHEN 'pending_removal' THEN 2
           WHEN 'active' THEN 3
           ELSE 1
         END,
         s.created_at ASC
       LIMIT ?${statuses.length + 1}`
    )
    .bind(...statuses, limit)
    .all<Record<string, unknown>>();

  return (result.results ?? []).map((row) => mapSubmission(row));
}

export async function deleteSubmissionsByFilePathPrefix(db: D1Database, prefix: string): Promise<number> {
  const result = await db
    .prepare("DELETE FROM ugc_submissions WHERE file_path LIKE ?1")
    .bind(`${prefix.replace(/%/g, "\\%")}/%`)
    .run();

  return result.meta.changes ?? 0;
}

export async function getSubmissionFilePathsByStatus(
  db: D1Database,
  status: SubmissionStatus,
  limit = 1000,
  offset = 0
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT file_path
       FROM ugc_submissions
       WHERE status = ?1
       ORDER BY created_at ASC
       LIMIT ?2 OFFSET ?3`
    )
    .bind(status, Math.min(Math.max(limit, 1), 1000), Math.max(offset, 0))
    .all<{ file_path: string }>();

  return (result.results ?? [])
    .map((row) => row.file_path)
    .filter(Boolean);
}

export async function deleteSubmissionsByStatus(db: D1Database, status: SubmissionStatus): Promise<number> {
  const result = await db
    .prepare("DELETE FROM ugc_submissions WHERE status = ?1")
    .bind(status)
    .run();

  return result.meta.changes ?? 0;
}

export async function getSubmissionById(db: D1Database, id: string): Promise<SubmissionRecord | null> {
  const row = await db.prepare("SELECT * FROM ugc_submissions WHERE id = ?1 LIMIT 1").bind(id).first<Record<string, unknown>>();
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
           moderation_note = ?3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?1`
    )
    .bind(payload.id, payload.status, payload.moderationNote ?? null)
    .run();
}

export async function listActiveImagesByMarker(
  db: D1Database,
  payload: {
    markerId?: string;
    markerIds?: string[];
    assetBaseUrl: string;
    limit?: number;
    pathPrefix?: string;
    excludePathPrefix?: string;
  }
): Promise<PublicSubmissionImage[]> {
  const requestedIds = payload.markerIds ?? (payload.markerId ? [payload.markerId] : []);
  const markerIds = [...new Set(requestedIds.map((item) => item.trim()).filter(Boolean))].slice(0, 100);
  if (markerIds.length === 0) {
    return [];
  }

  const placeholders = markerIds.map((_, index) => `?${index + 1}`).join(", ");
  const limit = Math.min(Math.max(payload.limit ?? 6, 1), 24);
  const filters: string[] = [
    `poi_id IN (${placeholders})`,
    "status = 'active'"
  ];
  const extraBindings: Array<string | number> = [];
  if (payload.pathPrefix) {
    filters.push(`file_path LIKE ?${markerIds.length + extraBindings.length + 1}`);
    extraBindings.push(`${payload.pathPrefix}/%`);
  }
  if (payload.excludePathPrefix) {
    filters.push(`file_path NOT LIKE ?${markerIds.length + extraBindings.length + 1}`);
    extraBindings.push(`${payload.excludePathPrefix}/%`);
  }
  const result = await db
    .prepare(
      `SELECT *
       FROM ugc_submissions
       WHERE ${filters.join(" AND ")}
       ORDER BY poi_id ASC, created_at DESC
       LIMIT ?${markerIds.length + extraBindings.length + 1}`
    )
    .bind(...markerIds, ...extraBindings, limit * markerIds.length)
    .all<Record<string, unknown>>();

  return (result.results ?? []).map((row) => {
    const submission = mapSubmission(row);
    return {
      id: submission.id,
      markerId: submission.markerId,
      poiHash: submission.poiHash,
      poiType: submission.poiType,
      snapshotId: submission.snapshotId,
      url: `${payload.assetBaseUrl}/${submission.filePath}`,
      content: submission.content,
      createdAt: submission.createdAt
    };
  });
}

function mapStatus(value: unknown): SubmissionStatus {
  if (
    value === "pending_openai" ||
    value === "pending_audit" ||
    value === "active" ||
    value === "flagged" ||
    value === "pending_removal" ||
    value === "stale"
  ) {
    return value;
  }
  return "pending_openai";
}

export const ALL_STATUSES: SubmissionStatus[] = [
  "pending_openai",
  "pending_audit",
  "active",
  "flagged",
  "pending_removal",
  "stale"
];
