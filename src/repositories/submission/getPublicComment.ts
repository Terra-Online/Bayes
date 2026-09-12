import { publicCommentFromRow } from "./mapper";
import type { PublicSubmissionComment } from "./types";

export interface PublicCommentContext {
  targetId: string;
  path: PublicSubmissionComment[];
  replies: PublicSubmissionComment[];
  repliesTruncated: boolean;
}

const ANCESTOR_CONTEXT_LIMIT = 64;
const REPLY_CONTEXT_LIMIT = 10;
const REPLY_TRAVERSAL_LIMIT = 256;

export async function getPublicCommentContextById(
  db: D1Database,
  payload: { id: string; markerId: string }
): Promise<PublicCommentContext | null> {
  const result = await db
    .prepare(
      `WITH RECURSIVE comment_path AS (
         SELECT s.*, 0 AS ancestor_distance, json_array(s.id) AS visited_ids
         FROM ugc_submissions s
         WHERE s.id = ?1
           AND s.poi_id = ?2
           AND s.kind = 'comment'
           AND s.status IN ('active', 'flagged', 'remove_request')
         UNION ALL
         SELECT
           parent.*,
           child.ancestor_distance + 1,
           json_insert(child.visited_ids, '$[#]', parent.id)
         FROM comment_path child
         INNER JOIN ugc_submissions parent ON parent.id = child.parent_id
         WHERE parent.poi_id = ?2
           AND parent.kind = 'comment'
           AND child.ancestor_distance < ?3
           AND NOT EXISTS (
             SELECT 1
             FROM json_each(child.visited_ids) visited
             WHERE visited.value = parent.id
           )
       )
       SELECT
         path.*,
         COALESCE((
           SELECT SUM(value)
           FROM ugc_submission_votes
           WHERE submission_id = path.id AND active = 1
         ), 0) AS score,
         (SELECT COUNT(*)
          FROM ugc_submissions child INDEXED BY idx_ugc_visible_comment_parent
          WHERE child.parent_id = path.id
            AND child.kind = 'comment'
            AND child.status IN ('active', 'flagged', 'remove_request')) AS reply_count,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname,
         u.avt AS user_avt
       FROM comment_path path
       LEFT JOIN users u ON u.uid = path.user_id
       WHERE path.status IN ('active', 'flagged', 'remove_request')
       ORDER BY path.ancestor_distance DESC`
    )
    .bind(payload.id, payload.markerId, ANCESTOR_CONTEXT_LIMIT)
    .all<Record<string, unknown>>();

  const path = (result.results ?? []).map((row) => publicCommentFromRow(row));
  if (path.length === 0) return null;

  const replyResult = await db
    .prepare(
      `WITH RECURSIVE reply_context AS (
         SELECT s.*, 0 AS relative_depth, json_array(s.id) AS visited_ids
         FROM ugc_submissions s
         WHERE s.id = ?1
           AND s.poi_id = ?2
           AND s.kind = 'comment'
           AND s.status IN ('active', 'flagged', 'remove_request')
         UNION ALL
         SELECT
           child.*,
           parent.relative_depth + 1,
           json_insert(parent.visited_ids, '$[#]', child.id)
         FROM reply_context parent
         INNER JOIN ugc_submissions child ON child.parent_id = parent.id
         WHERE child.poi_id = ?2
           AND child.kind = 'comment'
           AND parent.relative_depth < ?3
           AND NOT EXISTS (
             SELECT 1
             FROM json_each(parent.visited_ids) visited
             WHERE visited.value = child.id
           )
         ORDER BY relative_depth ASC, created_at ASC, id ASC
         LIMIT ?4
       ),
       traversal_meta AS (
         SELECT COUNT(*) AS traversed_count,
           EXISTS (
             SELECT 1 FROM reply_context boundary
             WHERE boundary.relative_depth = ?3
               AND EXISTS (
                 SELECT 1 FROM ugc_submissions child
                 WHERE child.parent_id = boundary.id
                   AND child.poi_id = ?2
                   AND child.kind = 'comment'
                   AND NOT EXISTS (
                     SELECT 1 FROM json_each(boundary.visited_ids) visited
                     WHERE visited.value = child.id
                   )
               )
           ) AS depth_truncated
         FROM reply_context
       ),
       selected_replies AS MATERIALIZED (
         SELECT *
         FROM reply_context
         WHERE relative_depth > 0
           AND status IN ('active', 'flagged', 'remove_request')
         ORDER BY relative_depth ASC, created_at ASC, id ASC
         LIMIT ?5
       )
       SELECT
         reply.*,
         meta.traversed_count,
         meta.depth_truncated,
         COALESCE((
           SELECT SUM(value)
           FROM ugc_submission_votes
           WHERE submission_id = reply.id AND active = 1
         ), 0) AS score,
         (SELECT COUNT(*)
          FROM ugc_submissions child INDEXED BY idx_ugc_visible_comment_parent
          WHERE child.parent_id = reply.id
            AND child.kind = 'comment'
            AND child.status IN ('active', 'flagged', 'remove_request')) AS reply_count,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname,
         u.avt AS user_avt
       FROM traversal_meta meta
       LEFT JOIN selected_replies reply ON TRUE
       LEFT JOIN users u ON u.uid = reply.user_id
       ORDER BY reply.relative_depth ASC, reply.created_at ASC, reply.id ASC`
    )
    .bind(
      payload.id,
      payload.markerId,
      ANCESTOR_CONTEXT_LIMIT,
      REPLY_TRAVERSAL_LIMIT + 1,
      REPLY_CONTEXT_LIMIT + 1
    )
    .all<Record<string, unknown>>();

  const traversedCount = Number(replyResult.results?.[0]?.traversed_count ?? 0);
  // Hidden children also count: their public descendants were not explored.
  const depthTruncated = Number(replyResult.results?.[0]?.depth_truncated ?? 0) === 1;
  const replyCandidates = (replyResult.results ?? [])
    .filter((row) => row.id !== null && row.id !== undefined)
    .map((row) => publicCommentFromRow(row));
  const traversalExhausted = traversedCount >= REPLY_TRAVERSAL_LIMIT + 1;
  return {
    targetId: payload.id,
    path,
    replies: replyCandidates.slice(0, REPLY_CONTEXT_LIMIT),
    repliesTruncated:
      traversalExhausted || depthTruncated || replyCandidates.length > REPLY_CONTEXT_LIMIT
  };
}
