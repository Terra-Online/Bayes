import { publicCommentRows, retainedCommentRows } from "./commentReadSql";
import { publicCommentNodeFromRow } from "./mapper";
import type { PublicCommentNode } from "./types";

export interface PublicCommentContext {
  targetId: string;
  path: PublicCommentNode[];
  replies: PublicCommentNode[];
  repliesTruncated: boolean;
}

const ANCESTOR_CONTEXT_LIMIT = 64;
const REPLY_CONTEXT_LIMIT = 10;
const REPLY_TRAVERSAL_LIMIT = 256;

export async function getPublicCommentContextById(
  db: D1Database,
  payload: { id: string; markerId: string; viewerUserId?: string },
): Promise<PublicCommentContext | null> {
  const pathViewerSelect = payload.viewerUserId
    ? `,
         COALESCE((SELECT value FROM ugc_submission_votes
           WHERE submission_id = path.id AND user_id = ?4 AND active = 1), 0) AS viewer_vote,
         EXISTS(SELECT 1 FROM ugc_submission_flags
           WHERE submission_id = path.id AND user_id = ?4 AND active = 1) AS viewer_flagged`
    : "";
  const result = await db
    .prepare(
      `WITH RECURSIVE ${publicCommentRows}, ${retainedCommentRows("SELECT ?2")}, comment_path AS (
         SELECT s.*, 0 AS ancestor_distance, json_array(s.id) AS visited_ids
         FROM comment_rows s
         WHERE s.id = ?1
           AND s.poi_id = ?2
           AND s.kind = 'comment'
         UNION ALL
         SELECT
           parent.*,
           child.ancestor_distance + 1,
           json_insert(child.visited_ids, '$[#]', parent.id)
         FROM comment_path child
         INNER JOIN comment_rows parent ON parent.id = child.parent_id
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
         (SELECT COUNT(*) FROM ugc_submission_flags WHERE submission_id = path.id AND active = 1) AS flag_count,
         COALESCE((
           SELECT SUM(value)
           FROM ugc_submission_votes
           WHERE submission_id = path.id AND active = 1
         ), 0) AS score,
         (SELECT COUNT(*)
          FROM comment_rows child
          WHERE child.parent_id = path.id
            AND child.kind = 'comment'
            AND child.id IN (SELECT id FROM retained_comments)) AS reply_count,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname,
         u.avt AS user_avt
         ${pathViewerSelect}
       FROM comment_path path
       LEFT JOIN users u ON u.uid = path.user_id
       ORDER BY path.ancestor_distance DESC`,
    )
    .bind(
      payload.id,
      payload.markerId,
      ANCESTOR_CONTEXT_LIMIT,
      ...(payload.viewerUserId ? [payload.viewerUserId] : []),
    )
    .all<Record<string, unknown>>();

  const path = (result.results ?? []).map((row) =>
    publicCommentNodeFromRow(row, payload.viewerUserId),
  );
  if (path.length === 0) {
    return null;
  }

  const replyViewerSelect = payload.viewerUserId
    ? `,
         COALESCE((SELECT value FROM ugc_submission_votes
           WHERE submission_id = reply.id AND user_id = ?6 AND active = 1), 0) AS viewer_vote,
         EXISTS(SELECT 1 FROM ugc_submission_flags
           WHERE submission_id = reply.id AND user_id = ?6 AND active = 1) AS viewer_flagged`
    : "";
  const replyResult = await db
    .prepare(
      `WITH RECURSIVE ${publicCommentRows}, ${retainedCommentRows("SELECT ?2")}, reply_context AS (
         SELECT s.*, 0 AS relative_depth, json_array(s.id) AS visited_ids
         FROM comment_rows s
         WHERE s.id = ?1
           AND s.poi_id = ?2
           AND s.kind = 'comment'
         UNION ALL
         SELECT
           child.*,
           parent.relative_depth + 1,
           json_insert(parent.visited_ids, '$[#]', child.id)
         FROM reply_context parent
         INNER JOIN comment_rows child ON child.parent_id = parent.id
         JOIN retained_comments retained ON retained.id=child.id
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
           EXISTS(SELECT 1 FROM reply_context WHERE relative_depth>0 AND snapshot_id IS NOT NULL) AS has_public_reply,
           EXISTS (
             SELECT 1 FROM reply_context boundary
             WHERE boundary.relative_depth = ?3
               AND EXISTS (
                 SELECT 1 FROM comment_rows child
                 WHERE child.parent_id = boundary.id
                   AND child.poi_id = ?2
                   AND child.kind = 'comment'
                   AND child.id IN (SELECT id FROM retained_comments)
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
         ORDER BY relative_depth ASC, created_at ASC, id ASC
         LIMIT ?5
       )
       SELECT
         reply.*,
         (SELECT COUNT(*) FROM ugc_submission_flags WHERE submission_id = reply.id AND active = 1) AS flag_count,
         meta.traversed_count,
         meta.has_public_reply,
         meta.depth_truncated,
         COALESCE((
           SELECT SUM(value)
           FROM ugc_submission_votes
           WHERE submission_id = reply.id AND active = 1
         ), 0) AS score,
         (SELECT COUNT(*)
          FROM comment_rows child
          WHERE child.parent_id = reply.id
            AND child.kind = 'comment'
            AND child.id IN (SELECT id FROM retained_comments)) AS reply_count,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname,
         u.avt AS user_avt
         ${replyViewerSelect}
       FROM traversal_meta meta
       LEFT JOIN selected_replies reply ON TRUE
       LEFT JOIN users u ON u.uid = reply.user_id
       ORDER BY reply.relative_depth ASC, reply.created_at ASC, reply.id ASC`,
    )
    .bind(
      payload.id,
      payload.markerId,
      ANCESTOR_CONTEXT_LIMIT,
      REPLY_TRAVERSAL_LIMIT + 1,
      REPLY_CONTEXT_LIMIT + 1,
      ...(payload.viewerUserId ? [payload.viewerUserId] : []),
    )
    .all<Record<string, unknown>>();

  const traversedCount = Number(replyResult.results?.[0]?.traversed_count ?? 0);
  // Hidden children also count: their public descendants were not explored.
  const depthTruncated = Number(replyResult.results?.[0]?.depth_truncated ?? 0) === 1;
  const replyCandidates = (replyResult.results ?? [])
    .filter((row) => row.id !== null && row.id !== undefined)
    .map((row) => publicCommentNodeFromRow(row, payload.viewerUserId));
  const traversalExhausted = traversedCount >= REPLY_TRAVERSAL_LIMIT + 1;
  // A bounded prefix may end inside a hidden chain. Omit that incomplete
  // branch rather than returning a placeholder with no selected public content.
  const selected = replyCandidates.slice(0, REPLY_CONTEXT_LIMIT);
  const retained = new Set<string>();
  for (const node of [...selected].reverse()) {
    if (node.type === "comment" || retained.has(node.id)) {
      retained.add(node.id);
      if (node.parentId) {
        retained.add(node.parentId);
      }
    }
  }
  return {
    targetId: payload.id,
    path,
    replies: selected.filter((node) => retained.has(node.id)),
    repliesTruncated:
      traversalExhausted ||
      depthTruncated ||
      (Boolean(replyResult.results?.[0]?.has_public_reply) &&
        replyCandidates.length > REPLY_CONTEXT_LIMIT),
  };
}
