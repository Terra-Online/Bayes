import { publicCommentFromRow, userCommentFromRow } from "./mapper";
import type {
  PublicSubmissionComment,
  UserSubmissionComment,
  ViewerVoteValue
} from "./types";

export interface CommentViewerReaction {
  viewerVote: ViewerVoteValue;
  flagged: boolean;
}

export interface CommentViewerState {
  pendingComments: UserSubmissionComment[];
  reactions: Map<string, CommentViewerReaction>;
}

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
  const viewerSelect = payload.viewerUserId
    ? `,
         COALESCE(vv.value, 0) AS viewer_vote,
         CASE WHEN vf.user_id IS NULL THEN 0 ELSE 1 END AS viewer_flagged`
    : "";
  const viewerJoin = payload.viewerUserId
    ? `
       LEFT JOIN ugc_submission_votes vv ON vv.submission_id = s.id AND vv.user_id = ?4 AND vv.active = 1
       LEFT JOIN ugc_submission_flags vf ON vf.submission_id = s.id AND vf.user_id = ?4 AND vf.active = 1`
    : "";
  const viewerBindings = payload.viewerUserId ? [payload.viewerUserId] : [];

  const result = await db
    .prepare(
      `WITH RECURSIVE matching_roots AS MATERIALIZED (
         SELECT id, poi_id, created_at
         FROM ugc_submissions INDEXED BY idx_ugc_comment_threads
         WHERE poi_id IN (SELECT value FROM json_each(?1))
           AND kind = 'comment'
           AND comment_depth = 0
           AND parent_id IS NULL
           AND status IN ('active', 'flagged', 'remove_request')
       ),
       root_candidates AS (
         SELECT
           s.*,
           COALESCE(v.score, 0) AS score
         FROM matching_roots s
         LEFT JOIN (
           SELECT submission_id, SUM(value) AS score
           FROM ugc_submission_votes INDEXED BY sqlite_autoindex_ugc_submission_votes_1
           WHERE active = 1
             AND submission_id IN (SELECT id FROM matching_roots)
           GROUP BY submission_id
         ) v ON v.submission_id = s.id
       ),
       selected_roots AS MATERIALIZED (
         SELECT *
         FROM (
           SELECT
             *,
             ROW_NUMBER() OVER (PARTITION BY poi_id ORDER BY score DESC, created_at DESC, id DESC) AS poi_rank
           FROM root_candidates
         )
         WHERE poi_rank <= ?2
       ),
       visible_replies AS (
         SELECT id, parent_id, created_at
         FROM ugc_submissions INDEXED BY idx_ugc_visible_comment_parent
         WHERE ?3 > 0
           AND parent_id IN (SELECT id FROM selected_roots)
           AND kind = 'comment'
           AND status IN ('active', 'flagged', 'remove_request')
         UNION ALL
         SELECT child.id, child.parent_id, child.created_at
         FROM visible_replies parent
         CROSS JOIN ugc_submissions child INDEXED BY idx_ugc_visible_comment_parent ON child.parent_id = parent.id
         WHERE child.kind = 'comment'
           AND child.status IN ('active', 'flagged', 'remove_request')
       ),
       reply_candidates AS (
         SELECT
           s.id,
           ROW_NUMBER() OVER (PARTITION BY s.parent_id ORDER BY s.created_at ASC, s.id ASC) AS reply_rank
         FROM visible_replies s
       ),
       selected_comments AS (
         SELECT id, score, poi_rank AS root_rank
         FROM selected_roots
         UNION ALL
         SELECT id, NULL AS score, NULL AS root_rank
         FROM reply_candidates
         WHERE reply_rank <= ?3
       )
       SELECT
         s.*,
         COALESCE(selected.score, (
           SELECT SUM(value) FROM ugc_submission_votes INDEXED BY sqlite_autoindex_ugc_submission_votes_1
           WHERE submission_id = s.id AND active = 1
         ), 0) AS score,
         (SELECT COUNT(*) FROM ugc_submission_flags
          WHERE submission_id = s.id AND active = 1) AS flag_count,
         (SELECT COUNT(*) FROM ugc_submissions child INDEXED BY idx_ugc_visible_comment_parent
          WHERE child.parent_id = s.id
            AND child.kind = 'comment'
            AND child.status IN ('active', 'flagged', 'remove_request')) AS reply_count,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname,
         u.avt AS user_avt
         ${viewerSelect}
       FROM selected_comments selected
       CROSS JOIN ugc_submissions s ON s.id = selected.id
       ${viewerJoin}
       LEFT JOIN users u ON u.uid = s.user_id
       ORDER BY (selected.root_rank IS NULL) ASC,
         CASE WHEN selected.root_rank IS NOT NULL THEN s.poi_id END ASC,
         selected.root_rank ASC, s.comment_depth ASC, s.parent_id ASC, s.created_at ASC, s.id ASC`
    )
    .bind(JSON.stringify(markerIds), limit, replyLimit, ...viewerBindings)
    .all<Record<string, unknown>>();

  const comments = (result.results ?? []).map((row) => publicCommentFromRow(row, payload.viewerUserId));
  const roots = comments.filter((comment) => comment.parentId === null);
  const replies = comments.filter((comment) => comment.parentId !== null);
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

  const limit = Math.min(Math.max(payload.limit ?? 50, 1), 200);
  const limitPlaceholder = 3;
  const result = await db
    .prepare(
      `WITH selected_comments AS MATERIALIZED (
         SELECT *
         FROM ugc_submissions INDEXED BY idx_ugc_user_kind_poi_created
         WHERE user_id = ?1
           AND poi_id IN (SELECT value FROM json_each(?2))
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
         FROM ugc_submission_votes INDEXED BY sqlite_autoindex_ugc_submission_votes_1
         WHERE active = 1
           AND submission_id IN (SELECT id FROM selected_comments)
         GROUP BY submission_id
       ) v ON v.submission_id = s.id
       LEFT JOIN (
         SELECT submission_id, COUNT(*) AS flag_count
         FROM ugc_submission_flags
         WHERE active = 1
           AND submission_id IN (SELECT id FROM selected_comments)
         GROUP BY submission_id
       ) f ON f.submission_id = s.id
       LEFT JOIN ugc_submission_votes vv ON vv.submission_id = s.id AND vv.user_id = ?1 AND vv.active = 1
       LEFT JOIN ugc_submission_flags vf ON vf.submission_id = s.id AND vf.user_id = ?1 AND vf.active = 1
       LEFT JOIN users u ON u.uid = s.user_id
       ORDER BY s.created_at DESC, s.id DESC`
    )
    .bind(payload.userId, JSON.stringify(markerIds), limit)
    .all<Record<string, unknown>>();

  return (result.results ?? []).map((row) => userCommentFromRow(row));
}

export async function listCommentViewerStateByMarker(
  db: D1Database,
  payload: {
    userId: string;
    markerIds: string[];
    submissionIds: string[];
    pendingLimit?: number;
  }
): Promise<CommentViewerState> {
  const markerIds = [...new Set(payload.markerIds.map((item) => item.trim()).filter(Boolean))].slice(0, 100);
  if (markerIds.length === 0) {
    return { pendingComments: [], reactions: new Map() };
  }

  const pendingLimit = Math.min(Math.max(payload.pendingLimit ?? 200, 1), 200);
  const pendingLimitPlaceholder = 3;
  const pendingStatement = db.prepare(
    `WITH selected_comments AS MATERIALIZED (
       SELECT *
       FROM ugc_submissions INDEXED BY idx_ugc_user_pending_comment
       WHERE user_id = ?1
         AND poi_id IN (SELECT value FROM json_each(?2))
         AND kind = 'comment'
         AND status IN ('pending_openai', 'pending_audit')
       ORDER BY created_at DESC, id DESC
       LIMIT ?${pendingLimitPlaceholder}
     )
     SELECT
       s.*,
       COALESCE(v.score, 0) AS score,
       COALESCE(f.flag_count, 0) AS flag_count,
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
       FROM ugc_submission_votes INDEXED BY sqlite_autoindex_ugc_submission_votes_1
       WHERE active = 1
         AND submission_id IN (SELECT id FROM selected_comments)
       GROUP BY submission_id
     ) v ON v.submission_id = s.id
     LEFT JOIN (
       SELECT submission_id, COUNT(*) AS flag_count
       FROM ugc_submission_flags
       WHERE active = 1
         AND submission_id IN (SELECT id FROM selected_comments)
       GROUP BY submission_id
     ) f ON f.submission_id = s.id
     LEFT JOIN users u ON u.uid = s.user_id
     ORDER BY s.created_at DESC, s.id DESC`
  ).bind(payload.userId, JSON.stringify(markerIds), pendingLimit);

  const submissionIds = [...new Set(payload.submissionIds)];
  const reactionStatement = submissionIds.length > 0 ? db.prepare(
    `SELECT
       s.id,
       COALESCE(v.value, 0) AS viewer_vote,
       CASE WHEN f.user_id IS NULL THEN 0 ELSE 1 END AS viewer_flagged
     FROM ugc_submissions s INDEXED BY sqlite_autoindex_ugc_submissions_1
     LEFT JOIN ugc_submission_votes v ON v.submission_id = s.id AND v.user_id = ?1 AND v.active = 1
     LEFT JOIN ugc_submission_flags f ON f.submission_id = s.id AND f.user_id = ?1 AND f.active = 1
     WHERE s.poi_id IN (SELECT value FROM json_each(?2))
       AND s.id IN (SELECT value FROM json_each(?3))
       AND s.kind = 'comment'
       AND s.status IN ('active', 'flagged', 'remove_request')
       AND (v.user_id IS NOT NULL OR f.user_id IS NOT NULL)`
  ).bind(payload.userId, JSON.stringify(markerIds), JSON.stringify(submissionIds)) : null;

  const [pendingResult, reactionResult] = await db.batch<Record<string, unknown>>([
    pendingStatement,
    ...(reactionStatement ? [reactionStatement] : [])
  ]);
  const reactions = new Map<string, CommentViewerReaction>();
  (reactionResult?.results ?? []).forEach((row) => {
    const vote = Number(row.viewer_vote ?? 0);
    reactions.set(String(row.id), {
      viewerVote: vote === 1 ? 1 : vote === -1 ? -1 : 0,
      flagged: Boolean(row.viewer_flagged)
    });
  });

  return {
    pendingComments: (pendingResult.results ?? []).map((row) => userCommentFromRow(row)),
    reactions
  };
}
