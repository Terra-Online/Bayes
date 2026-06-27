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
  parentId: string | null;
  commentDepth: number;
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

export type SubmissionVoteValue = 1 | -1;
export type ViewerVoteValue = SubmissionVoteValue | 0;

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

export interface PublicSubmissionComment {
  id: string;
  markerId: string;
  poiHash: string;
  poiType: string;
  parentId: string | null;
  depth: number;
  content: string;
  author: {
    nickname: string;
    publicUid: string;
  } | null;
  status: SubmissionStatus;
  score: number;
  viewerVote?: ViewerVoteValue;
  flagged?: boolean;
  replyCount: number;
  replies: PublicSubmissionComment[];
  createdAt: string;
}

export interface UserSubmissionComment extends Omit<PublicSubmissionComment, "replies" | "replyCount"> {
  snapshotId: string;
  flagCount: number;
  replies?: PublicSubmissionComment[];
  replyCount?: number;
}

export interface CommentTranslationRecord {
  commentId: string;
  sourceLanguage: string;
  detectedSourceLanguage: string | null;
  targetLanguage: string;
  glossaryKey: string;
  sourceHash: string;
  translatedContent: string;
  provider: string;
  glossaryApplied: boolean;
  createdAt: string;
  updatedAt: string;
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
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    commentDepth: toCount(row.comment_depth),
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

export async function setSubmissionVote(
  db: D1Database,
  payload: {
    submissionId: string;
    userId: string;
    value: SubmissionVoteValue;
  }
): Promise<ViewerVoteValue> {
  const current = await db
    .prepare(
      `SELECT value
       FROM ugc_submission_votes
       WHERE submission_id = ?1
         AND user_id = ?2
       LIMIT 1`
    )
    .bind(payload.submissionId, payload.userId)
    .first<{ value: number | string }>();

  const currentValue = mapVoteValue(current?.value);
  if (currentValue === payload.value) {
    await db
      .prepare(
        `DELETE FROM ugc_submission_votes
         WHERE submission_id = ?1
           AND user_id = ?2`
      )
      .bind(payload.submissionId, payload.userId)
      .run();
    return 0;
  }

  await db
    .prepare(
      `INSERT INTO ugc_submission_votes (submission_id, user_id, value)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(submission_id, user_id)
       DO UPDATE SET value = excluded.value,
                     updated_at = CURRENT_TIMESTAMP`
    )
    .bind(payload.submissionId, payload.userId, payload.value)
    .run();
  return payload.value;
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

export async function getSubmissionScore(db: D1Database, submissionId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(value), 0) AS score
       FROM ugc_submission_votes
       WHERE submission_id = ?1`
    )
    .bind(submissionId)
    .first<{ score: number | string }>();

  const score = Number(row?.score ?? 0);
  return Number.isFinite(score) ? Math.trunc(score) : 0;
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

function mapVoteValue(value: unknown): ViewerVoteValue {
  const numeric = Number(value ?? 0);
  if (numeric === 1) return 1;
  if (numeric === -1) return -1;
  return 0;
}

function publicCommentFromRow(
  row: Record<string, unknown>,
  viewerUserId?: string
): PublicSubmissionComment {
  const submission = mapSubmission(row);
  return {
    id: submission.id,
    markerId: submission.markerId,
    poiHash: submission.poiHash,
    poiType: submission.poiType,
    parentId: submission.parentId,
    depth: submission.commentDepth,
    content: submission.content ?? "",
    author: submission.submitter?.publicUid && submission.submitter.nickname
      ? {
          nickname: submission.submitter.nickname,
          publicUid: submission.submitter.publicUid
        }
      : null,
    status: submission.status,
    score: Number(row.score ?? 0) || 0,
    viewerVote: viewerUserId ? mapVoteValue(row.viewer_vote) : undefined,
    flagged: viewerUserId ? Boolean(row.viewer_flagged) : undefined,
    replyCount: toCount(row.reply_count),
    replies: [],
    createdAt: submission.createdAt
  };
}

function userCommentFromRow(row: Record<string, unknown>): UserSubmissionComment {
  const comment = publicCommentFromRow(row);
  const submission = mapSubmission(row);
  return {
    ...comment,
    snapshotId: submission.snapshotId,
    flagCount: toCount(row.flag_count),
    replies: undefined,
    replyCount: undefined
  };
}

function buildCommentTree(
  roots: PublicSubmissionComment[],
  replies: PublicSubmissionComment[],
  replyLimit: number
): PublicSubmissionComment[] {
  const rootById = new Map(roots.map((root) => [root.id, root]));
  for (const reply of replies) {
    const root = reply.parentId ? rootById.get(reply.parentId) : undefined;
    if (!root) continue;
    root.replyCount += 1;
    if (root.replies.length < replyLimit) {
      root.replies.push(reply);
    }
  }
  return roots;
}

export async function listActiveCommentsByMarker(
  db: D1Database,
  payload: {
    markerId?: string;
    markerIds?: string[];
    limit?: number;
    replyLimit?: number;
    viewerUserId?: string;
  }
): Promise<PublicSubmissionComment[]> {
  const requestedIds = payload.markerIds ?? (payload.markerId ? [payload.markerId] : []);
  const markerIds = [...new Set(requestedIds.map((item) => item.trim()).filter(Boolean))].slice(0, 100);
  if (markerIds.length === 0) {
    return [];
  }

  const limit = Math.min(Math.max(payload.limit ?? 20, 1), 50);
  const replyLimit = Math.min(Math.max(payload.replyLimit ?? 3, 0), 10);
  const markerPlaceholders = markerIds.map((_, index) => `?${index + 1}`).join(", ");
  const limitPlaceholder = markerIds.length + 1;
  const viewerSelect = payload.viewerUserId
    ? `,
         COALESCE(vv.value, 0) AS viewer_vote,
         CASE WHEN vf.user_id IS NULL THEN 0 ELSE 1 END AS viewer_flagged`
    : "";
  const viewerJoin = payload.viewerUserId
    ? `
       LEFT JOIN ugc_submission_votes vv ON vv.submission_id = s.id AND vv.user_id = ?${limitPlaceholder + 1}
       LEFT JOIN ugc_submission_flags vf ON vf.submission_id = s.id AND vf.user_id = ?${limitPlaceholder + 2}`
    : "";
  const viewerBindings = payload.viewerUserId ? [payload.viewerUserId, payload.viewerUserId] : [];

  const rootResult = await db
    .prepare(
      `WITH root_candidates AS (
         SELECT
           s.*,
           COALESCE(v.score, 0) AS score,
           COALESCE(f.flag_count, 0) AS flag_count
         FROM ugc_submissions s
         LEFT JOIN (
           SELECT submission_id, SUM(value) AS score
           FROM ugc_submission_votes
           GROUP BY submission_id
         ) v ON v.submission_id = s.id
         LEFT JOIN (
           SELECT submission_id, COUNT(*) AS flag_count
           FROM ugc_submission_flags
           GROUP BY submission_id
         ) f ON f.submission_id = s.id
         WHERE s.poi_id IN (${markerPlaceholders})
           AND s.kind = 'comment'
           AND s.comment_depth = 0
           AND s.parent_id IS NULL
           AND s.status IN ('active', 'flagged', 'remove_request')
       ),
       selected_comments AS (
         SELECT *
         FROM (
           SELECT
             *,
             ROW_NUMBER() OVER (PARTITION BY poi_id ORDER BY score DESC, created_at DESC, id DESC) AS poi_rank
           FROM root_candidates
         )
         WHERE poi_rank <= ?${limitPlaceholder}
       ),
       reply_counts AS (
         SELECT parent_id, COUNT(*) AS reply_count
         FROM ugc_submissions
         WHERE parent_id IN (SELECT id FROM selected_comments)
           AND kind = 'comment'
           AND comment_depth = 1
           AND status IN ('active', 'flagged', 'remove_request')
         GROUP BY parent_id
       )
       SELECT
         s.*,
         COALESCE(s.score, 0) AS score,
         COALESCE(s.flag_count, 0) AS flag_count,
         COALESCE(r.reply_count, 0) AS reply_count,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname
         ${viewerSelect}
       FROM selected_comments s
       LEFT JOIN reply_counts r ON r.parent_id = s.id
       ${viewerJoin}
       LEFT JOIN users u ON u.uid = s.user_id
       ORDER BY s.poi_id ASC, s.score DESC, s.created_at DESC, s.id DESC`
    )
    .bind(...markerIds, limit, ...viewerBindings)
    .all<Record<string, unknown>>();

  const roots = (rootResult.results ?? []).map((row) => publicCommentFromRow(row, payload.viewerUserId));
  if (roots.length === 0 || replyLimit === 0) {
    return roots;
  }

  const rootIds = roots.map((root) => root.id);
  const rootPlaceholders = rootIds.map((_, index) => `?${index + 1}`).join(", ");
  const replyLimitPlaceholder = rootIds.length + 1;
  const replyViewerSelect = payload.viewerUserId
    ? `,
         COALESCE(vv.value, 0) AS viewer_vote,
         CASE WHEN vf.user_id IS NULL THEN 0 ELSE 1 END AS viewer_flagged`
    : "";
  const replyViewerJoin = payload.viewerUserId
    ? `
       LEFT JOIN ugc_submission_votes vv ON vv.submission_id = s.id AND vv.user_id = ?${replyLimitPlaceholder + 1}
       LEFT JOIN ugc_submission_flags vf ON vf.submission_id = s.id AND vf.user_id = ?${replyLimitPlaceholder + 2}`
    : "";
  const replyViewerBindings = payload.viewerUserId ? [payload.viewerUserId, payload.viewerUserId] : [];
  const replyResult = await db
    .prepare(
      `WITH reply_candidates AS (
         SELECT
           s.*,
           COALESCE(v.score, 0) AS score,
           COALESCE(f.flag_count, 0) AS flag_count,
           ROW_NUMBER() OVER (PARTITION BY s.parent_id ORDER BY s.created_at ASC, s.id ASC) AS reply_rank
         FROM ugc_submissions s
         LEFT JOIN (
           SELECT submission_id, SUM(value) AS score
           FROM ugc_submission_votes
           GROUP BY submission_id
         ) v ON v.submission_id = s.id
         LEFT JOIN (
           SELECT submission_id, COUNT(*) AS flag_count
           FROM ugc_submission_flags
           GROUP BY submission_id
         ) f ON f.submission_id = s.id
         WHERE s.parent_id IN (${rootPlaceholders})
           AND s.kind = 'comment'
           AND s.comment_depth = 1
           AND s.status IN ('active', 'flagged', 'remove_request')
       ),
       selected_comments AS (
         SELECT *
         FROM reply_candidates
         WHERE reply_rank <= ?${replyLimitPlaceholder}
       )
       SELECT
         s.*,
         COALESCE(s.score, 0) AS score,
         COALESCE(s.flag_count, 0) AS flag_count,
         0 AS reply_count,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname
         ${replyViewerSelect}
       FROM selected_comments s
       ${replyViewerJoin}
       LEFT JOIN users u ON u.uid = s.user_id
       ORDER BY s.parent_id ASC, s.created_at ASC, s.id ASC`
    )
    .bind(...rootIds, replyLimit, ...replyViewerBindings)
    .all<Record<string, unknown>>();

  const replies = (replyResult.results ?? []).map((row) => publicCommentFromRow(row, payload.viewerUserId));
  return buildCommentTree(roots, replies, replyLimit);
}

export async function listUserCommentsByMarker(
  db: D1Database,
  payload: {
    userId: string;
    markerId?: string;
    markerIds?: string[];
    limit?: number;
  }
): Promise<UserSubmissionComment[]> {
  const requestedIds = payload.markerIds ?? (payload.markerId ? [payload.markerId] : []);
  const markerIds = [...new Set(requestedIds.map((item) => item.trim()).filter(Boolean))].slice(0, 100);
  if (markerIds.length === 0) {
    return [];
  }

  const markerPlaceholders = markerIds.map((_, index) => `?${index + 2}`).join(", ");
  const limit = Math.min(Math.max(payload.limit ?? 50, 1), 200);
  const limitPlaceholder = markerIds.length + 2;
  const result = await db
    .prepare(
      `WITH selected_comments AS (
         SELECT *
         FROM ugc_submissions
         WHERE user_id = ?1
           AND poi_id IN (${markerPlaceholders})
           AND kind = 'comment'
           AND status IN ('pending_openai', 'pending_audit', 'active', 'flagged', 'remove_request')
         ORDER BY created_at DESC, id DESC
         LIMIT ?${limitPlaceholder}
       )
       SELECT
         s.*,
         COALESCE(v.score, 0) AS score,
         COALESCE(f.flag_count, 0) AS flag_count,
         COALESCE(vv.value, 0) AS viewer_vote,
         CASE WHEN vf.user_id IS NULL THEN 0 ELSE 1 END AS viewer_flagged,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname
       FROM selected_comments s
       LEFT JOIN (
         SELECT submission_id, SUM(value) AS score
         FROM ugc_submission_votes
         WHERE submission_id IN (SELECT id FROM selected_comments)
         GROUP BY submission_id
       ) v ON v.submission_id = s.id
       LEFT JOIN (
         SELECT submission_id, COUNT(*) AS flag_count
         FROM ugc_submission_flags
         WHERE submission_id IN (SELECT id FROM selected_comments)
         GROUP BY submission_id
       ) f ON f.submission_id = s.id
       LEFT JOIN ugc_submission_votes vv ON vv.submission_id = s.id AND vv.user_id = ?1
       LEFT JOIN ugc_submission_flags vf ON vf.submission_id = s.id AND vf.user_id = ?1
       LEFT JOIN users u ON u.uid = s.user_id
       ORDER BY s.created_at DESC, s.id DESC`
    )
    .bind(payload.userId, ...markerIds, limit)
    .all<Record<string, unknown>>();

  return (result.results ?? []).map((row) => userCommentFromRow(row));
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
  const limitBindingOffset = markerIds.length + scope.bindings.length;
  const viewerBindingOffset = limitBindingOffset + 1;
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
      `WITH ranked_images AS (
         SELECT
           *,
           ROW_NUMBER() OVER (PARTITION BY poi_id ORDER BY created_at DESC, id DESC) AS poi_rank
         FROM ugc_submissions
         WHERE ${filters.join(" AND ")}
       ),
       selected_images AS (
         SELECT *
         FROM ranked_images
         WHERE poi_rank <= ?${limitBindingOffset + 1}
       ),
       upvote_counts AS (
         SELECT submission_id, COUNT(*) AS upvote_count
         FROM ugc_submission_upvotes
         WHERE submission_id IN (SELECT id FROM selected_images)
         GROUP BY submission_id
       ),
       flag_counts AS (
         SELECT submission_id, COUNT(*) AS flag_count
         FROM ugc_submission_flags
         WHERE submission_id IN (SELECT id FROM selected_images)
         GROUP BY submission_id
       )
       SELECT
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
       FROM selected_images s
       LEFT JOIN upvote_counts v ON v.submission_id = s.id
       LEFT JOIN flag_counts f ON f.submission_id = s.id
       ${viewerJoin}
       LEFT JOIN users u ON u.uid = s.user_id
       ORDER BY s.poi_id ASC, s.created_at DESC, s.id DESC`
    )
    .bind(...markerIds, ...scope.bindings, limit, ...viewerBindings)
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
    privateAssetBaseUrl: string;
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
  const limitBindingOffset = markerIds.length + extraBindings.length + 1;

  const result = await db
    .prepare(
      `WITH ranked_images AS (
         SELECT
           *,
           ROW_NUMBER() OVER (PARTITION BY poi_id ORDER BY created_at DESC, id DESC) AS poi_rank
         FROM ugc_submissions
         WHERE ${filters.join(" AND ")}
       ),
       selected_images AS (
         SELECT *
         FROM ranked_images
         WHERE poi_rank <= ?${limitBindingOffset + 1}
       ),
       upvote_counts AS (
         SELECT submission_id, COUNT(*) AS upvote_count
         FROM ugc_submission_upvotes
         WHERE submission_id IN (SELECT id FROM selected_images)
         GROUP BY submission_id
       ),
       flag_counts AS (
         SELECT submission_id, COUNT(*) AS flag_count
         FROM ugc_submission_flags
         WHERE submission_id IN (SELECT id FROM selected_images)
         GROUP BY submission_id
       )
       SELECT
         s.*,
         COALESCE(v.upvote_count, 0) AS upvote_count,
         COALESCE(f.flag_count, 0) AS flag_count,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname
       FROM selected_images s
       LEFT JOIN upvote_counts v ON v.submission_id = s.id
       LEFT JOIN flag_counts f ON f.submission_id = s.id
       LEFT JOIN users u ON u.uid = s.user_id
       ORDER BY s.poi_id ASC, s.created_at DESC, s.id DESC`
    )
    .bind(payload.userId, ...markerIds, ...extraBindings, limit)
    .all<Record<string, unknown>>();

  return (result.results ?? []).map((row) => {
    const submission = mapSubmission(row);
    const filePath = submission.filePath ?? "";
    const assetBaseUrl = submission.status === "pending_openai" || submission.status === "pending_audit"
      ? payload.privateAssetBaseUrl
      : payload.assetBaseUrl;
    return {
      id: submission.id,
      markerId: submission.markerId,
      poiHash: submission.poiHash,
      poiType: submission.poiType,
      snapshotId: submission.snapshotId,
      url: `${assetBaseUrl}/${filePath}`,
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

function mapCommentTranslation(row: Record<string, unknown>): CommentTranslationRecord {
  return {
    commentId: String(row.comment_id),
    sourceLanguage: String(row.source_language),
    detectedSourceLanguage: row.detected_source_language === null || row.detected_source_language === undefined
      ? null
      : String(row.detected_source_language),
    targetLanguage: String(row.target_language),
    glossaryKey: String(row.glossary_key ?? ""),
    sourceHash: String(row.source_hash),
    translatedContent: String(row.translated_content ?? ""),
    provider: String(row.provider ?? "google_cloud_translation_v3"),
    glossaryApplied: Boolean(row.glossary_applied),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
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
