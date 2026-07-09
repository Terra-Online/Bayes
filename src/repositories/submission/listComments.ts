import { publicCommentFromRow, userCommentFromRow } from "./mapper";
import type { PublicSubmissionComment, UserSubmissionComment } from "./types";

function buildCommentTree(
  roots: PublicSubmissionComment[],
  replies: PublicSubmissionComment[],
  replyLimit: number
): PublicSubmissionComment[] {
  const commentById = new Map(roots.map((root) => [root.id, root]));
  for (const reply of replies) {
    commentById.set(reply.id, reply);
  }

  for (const reply of replies) {
    const parent = reply.parentId ? commentById.get(reply.parentId) : undefined;
    if (!parent) continue;
    if (parent.replies.length < replyLimit) {
      parent.replies.push(reply);
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
      `WITH RECURSIVE root_candidates AS (
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
       visible_replies AS (
         SELECT *
         FROM ugc_submissions
         WHERE parent_id IN (SELECT id FROM selected_comments)
           AND kind = 'comment'
           AND status IN ('active', 'flagged', 'remove_request')
         UNION ALL
         SELECT child.*
         FROM ugc_submissions child
         INNER JOIN visible_replies parent ON child.parent_id = parent.id
         WHERE child.kind = 'comment'
           AND child.status IN ('active', 'flagged', 'remove_request')
       ),
       reply_counts AS (
         SELECT parent_id, COUNT(*) AS reply_count
         FROM visible_replies
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
         u.nickname AS user_nickname,
         u.avt AS user_avt
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
      `WITH RECURSIVE visible_replies AS (
         SELECT
           s.*
         FROM ugc_submissions s
         WHERE s.parent_id IN (${rootPlaceholders})
           AND s.kind = 'comment'
           AND s.status IN ('active', 'flagged', 'remove_request')
         UNION ALL
         SELECT
           child.*
         FROM ugc_submissions child
         INNER JOIN visible_replies parent ON child.parent_id = parent.id
         WHERE child.kind = 'comment'
           AND child.status IN ('active', 'flagged', 'remove_request')
       ),
       reply_candidates AS (
         SELECT
           s.*,
           COALESCE(v.score, 0) AS score,
           COALESCE(f.flag_count, 0) AS flag_count,
           ROW_NUMBER() OVER (PARTITION BY s.parent_id ORDER BY s.created_at ASC, s.id ASC) AS reply_rank
         FROM visible_replies s
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
       ),
       selected_comments AS (
         SELECT *
         FROM reply_candidates
         WHERE reply_rank <= ?${replyLimitPlaceholder}
       ),
       reply_counts AS (
         SELECT parent_id, COUNT(*) AS reply_count
         FROM visible_replies
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
         u.nickname AS user_nickname,
         u.avt AS user_avt
         ${replyViewerSelect}
       FROM selected_comments s
       ${replyViewerJoin}
       LEFT JOIN reply_counts r ON r.parent_id = s.id
       LEFT JOIN users u ON u.uid = s.user_id
       ORDER BY s.comment_depth ASC, s.parent_id ASC, s.created_at ASC, s.id ASC`
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
         u.nickname AS user_nickname,
         u.avt AS user_avt
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
