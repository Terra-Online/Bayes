import { formatPublicUid } from "./users";

export interface SubmissionRecord {
  id: string;
  kind: SubmissionKind;
  markerId: string;
  poiHash: string;
  poiType: string;
  snapshotId: string;
  userId: string;
  content: string | null;
  filePath: string | null;
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
  | "remove_request"
  | "stale";

export type SubmissionKind = "image" | "comment";

export interface PublicSubmissionImage {
  id: string;
  markerId: string;
  url: string;
  content: string | null;
  author: {
    nickname: string;
    publicUid: string;
  } | null;
  status: SubmissionStatus;
  upvoteCount: number;
  upvoted?: boolean;
  flagged?: boolean;
  createdAt: string;
}

export interface UserSubmissionImage extends PublicSubmissionImage {
  poiHash: string;
  poiType: string;
  snapshotId: string;
  filePath: string;
  flagCount: number;
  status: SubmissionStatus;
}

export function toCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export function imageStatusListSql(statuses: SubmissionStatus[]): string {
  return statuses.map((status) => `'${status}'`).join(", ");
}

export function mapSubmission(row: Record<string, unknown>): SubmissionRecord {
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
    kind: mapKind(row.kind),
    markerId: String(row.poi_id),
    poiHash: String(row.poi_hash),
    poiType: String(row.poi_type),
    snapshotId: String(row.snapshot_id),
    userId: String(row.user_id),
    content: row.content === null ? null : String(row.content ?? ""),
    filePath: row.file_path === null || row.file_path === undefined ? null : String(row.file_path),
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
    kind?: SubmissionKind;
    filePath?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
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
         kind,
         file_path,
         status,
         mime_type,
         size_bytes
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
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
      payload.sizeBytes ?? null
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

export async function createSubmissionUpvote(
  db: D1Database,
  payload: {
    submissionId: string;
    userId: string;
  }
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO ugc_submission_upvotes (submission_id, user_id)
       VALUES (?1, ?2)`
    )
    .bind(payload.submissionId, payload.userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function deleteSubmissionUpvote(
  db: D1Database,
  payload: {
    submissionId: string;
    userId: string;
  }
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM ugc_submission_upvotes
       WHERE submission_id = ?1
         AND user_id = ?2`
    )
    .bind(payload.submissionId, payload.userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function createSubmissionFlag(
  db: D1Database,
  payload: {
    submissionId: string;
    userId: string;
  }
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO ugc_submission_flags (submission_id, user_id)
       VALUES (?1, ?2)`
    )
    .bind(payload.submissionId, payload.userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function deleteSubmissionFlag(
  db: D1Database,
  payload: {
    submissionId: string;
    userId: string;
  }
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM ugc_submission_flags
       WHERE submission_id = ?1
         AND user_id = ?2`
    )
    .bind(payload.submissionId, payload.userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function countSubmissionUpvotes(db: D1Database, submissionId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM ugc_submission_upvotes
       WHERE submission_id = ?1`
    )
    .bind(submissionId)
    .first<{ count: number | string }>();

  return toCount(row?.count);
}

export async function countSubmissionFlags(db: D1Database, submissionId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM ugc_submission_flags
       WHERE submission_id = ?1`
    )
    .bind(submissionId)
    .first<{ count: number | string }>();

  return toCount(row?.count);
}

export async function clearSubmissionFlags(db: D1Database, submissionId: string): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM ugc_submission_flags
       WHERE submission_id = ?1`
    )
    .bind(submissionId)
    .run();

  return result.meta.changes ?? 0;
}

export function buildImageScopeFilters(payload: {
  pathPrefix?: string;
  excludePathPrefix?: string;
}, bindingOffset = 0): { clauses: string[]; bindings: string[] } {
  const clauses: string[] = [];
  const bindings: string[] = [];
  if (payload.pathPrefix) {
    bindings.push(`${payload.pathPrefix}/%`);
    clauses.push(`file_path LIKE ?${bindingOffset + bindings.length}`);
  }
  if (payload.excludePathPrefix) {
    bindings.push(`${payload.excludePathPrefix}/%`);
    clauses.push(`file_path NOT LIKE ?${bindingOffset + bindings.length}`);
  }
  return { clauses, bindings };
}

export function publicImageFromRow(
  row: Record<string, unknown>,
  assetBaseUrl: string,
  viewerUserId?: string
): PublicSubmissionImage {
  const submission = mapSubmission(row);
  const filePath = submission.filePath ?? "";
  return {
    id: submission.id,
    markerId: submission.markerId,
    url: `${assetBaseUrl}/${filePath}`,
    content: submission.content,
    author: submission.submitter?.publicUid && submission.submitter.nickname
      ? {
          nickname: submission.submitter.nickname,
          publicUid: submission.submitter.publicUid
        }
      : null,
    status: submission.status,
    upvoteCount: toCount(row.upvote_count),
    upvoted: viewerUserId ? Boolean(row.viewer_upvoted) : undefined,
    flagged: viewerUserId ? Boolean(row.viewer_flagged) : undefined,
    createdAt: submission.createdAt
  };
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
    viewerUserId?: string;
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
    "kind = 'image'",
    "status IN ('active', 'flagged', 'remove_request')"
  ];
  const scope = buildImageScopeFilters(payload, markerIds.length);
  filters.push(...scope.clauses);
  const viewerBindingOffset = markerIds.length + scope.bindings.length;
  const viewerSelect = payload.viewerUserId
    ? `,
         CASE WHEN uv.user_id IS NULL THEN 0 ELSE 1 END AS viewer_upvoted,
         CASE WHEN uf.user_id IS NULL THEN 0 ELSE 1 END AS viewer_flagged`
    : "";
  const viewerJoin = payload.viewerUserId
    ? `
       LEFT JOIN ugc_submission_upvotes uv ON uv.submission_id = s.id AND uv.user_id = ?${viewerBindingOffset + 1}
       LEFT JOIN ugc_submission_flags uf ON uf.submission_id = s.id AND uf.user_id = ?${viewerBindingOffset + 2}`
    : "";
  const viewerBindings = payload.viewerUserId ? [payload.viewerUserId, payload.viewerUserId] : [];
  const result = await db
    .prepare(
      `SELECT
         s.*,
         COALESCE(v.upvote_count, 0) AS upvote_count,
         COALESCE(f.flag_count, 0) AS flag_count,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname
         ${viewerSelect}
       FROM ugc_submissions s
       LEFT JOIN (
         SELECT submission_id, COUNT(*) AS upvote_count
         FROM ugc_submission_upvotes
         GROUP BY submission_id
       ) v ON v.submission_id = s.id
       LEFT JOIN (
         SELECT submission_id, COUNT(*) AS flag_count
         FROM ugc_submission_flags
         GROUP BY submission_id
       ) f ON f.submission_id = s.id
       ${viewerJoin}
       LEFT JOIN users u ON u.uid = s.user_id
       WHERE ${filters.join(" AND ")}
       ORDER BY poi_id ASC, created_at DESC
       LIMIT ?${markerIds.length + scope.bindings.length + viewerBindings.length + 1}`
    )
    .bind(...markerIds, ...scope.bindings, ...viewerBindings, limit * markerIds.length)
    .all<Record<string, unknown>>();

  return (result.results ?? []).map((row) => publicImageFromRow(row, payload.assetBaseUrl, payload.viewerUserId));
}

export async function listUserImagesByMarker(
  db: D1Database,
  payload: {
    userId: string;
    markerId?: string;
    markerIds?: string[];
    assetBaseUrl: string;
    limit?: number;
    pathPrefix?: string;
    excludePathPrefix?: string;
  }
): Promise<UserSubmissionImage[]> {
  const requestedIds = payload.markerIds ?? (payload.markerId ? [payload.markerId] : []);
  const markerIds = [...new Set(requestedIds.map((item) => item.trim()).filter(Boolean))].slice(0, 100);
  if (markerIds.length === 0) {
    return [];
  }

  const placeholders = markerIds.map((_, index) => `?${index + 2}`).join(", ");
  const limit = Math.min(Math.max(payload.limit ?? 6, 1), 24);
  const filters: string[] = [
    "user_id = ?1",
    `poi_id IN (${placeholders})`,
    "kind = 'image'",
    "status IN ('pending_openai', 'pending_audit', 'active', 'flagged', 'remove_request')"
  ];
  const extraBindings: Array<string | number> = [];
  if (payload.pathPrefix) {
    filters.push(`file_path LIKE ?${markerIds.length + extraBindings.length + 2}`);
    extraBindings.push(`${payload.pathPrefix}/%`);
  }
  if (payload.excludePathPrefix) {
    filters.push(`file_path NOT LIKE ?${markerIds.length + extraBindings.length + 2}`);
    extraBindings.push(`${payload.excludePathPrefix}/%`);
  }

  const result = await db
    .prepare(
      `SELECT
         s.*,
         COALESCE(v.upvote_count, 0) AS upvote_count,
         COALESCE(f.flag_count, 0) AS flag_count,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname
       FROM ugc_submissions s
       LEFT JOIN (
         SELECT submission_id, COUNT(*) AS upvote_count
         FROM ugc_submission_upvotes
         GROUP BY submission_id
       ) v ON v.submission_id = s.id
       LEFT JOIN (
         SELECT submission_id, COUNT(*) AS flag_count
         FROM ugc_submission_flags
         GROUP BY submission_id
       ) f ON f.submission_id = s.id
       LEFT JOIN users u ON u.uid = s.user_id
       WHERE ${filters.join(" AND ")}
       ORDER BY poi_id ASC, created_at DESC
       LIMIT ?${markerIds.length + extraBindings.length + 2}`
    )
    .bind(payload.userId, ...markerIds, ...extraBindings, limit * markerIds.length)
    .all<Record<string, unknown>>();

  return (result.results ?? []).map((row) => {
    const submission = mapSubmission(row);
    const filePath = submission.filePath ?? "";
    return {
      id: submission.id,
      markerId: submission.markerId,
      poiHash: submission.poiHash,
      poiType: submission.poiType,
      snapshotId: submission.snapshotId,
      url: `${payload.assetBaseUrl}/${filePath}`,
      filePath,
      content: submission.content,
      createdAt: submission.createdAt,
      author: submission.submitter?.publicUid && submission.submitter.nickname
        ? {
            nickname: submission.submitter.nickname,
            publicUid: submission.submitter.publicUid
          }
        : null,
      upvoteCount: toCount(row.upvote_count),
      flagCount: toCount(row.flag_count),
      status: submission.status
    };
  });
}

export function mapKind(value: unknown): SubmissionKind {
  return value === "comment" ? "comment" : "image";
}

export function mapStatus(value: unknown): SubmissionStatus {
  if (
    value === "pending_openai" ||
    value === "pending_audit" ||
    value === "active" ||
    value === "flagged" ||
    value === "remove_request" ||
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
  "remove_request",
  "stale"
];
