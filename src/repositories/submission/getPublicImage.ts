import { buildImageScopeFilters } from "./listImages";
import { publicImageFromRow } from "./mapper";
import type { PublicSubmissionImage } from "./types";

export async function getPublicImageById(
  db: D1Database,
  payload: {
    id: string;
    markerId: string;
    assetBaseUrl: string;
    pathPrefix?: string;
    excludePathPrefix?: string;
    viewerUserId?: string;
  },
): Promise<PublicSubmissionImage | null> {
  const scope = buildImageScopeFilters(payload, 2);
  const filters = [
    "s.id = ?1",
    "s.poi_id = ?2",
    "s.kind = 'image'",
    "s.status IN ('active', 'flagged', 'remove_request')",
    ...scope.clauses.map((clause) => `s.${clause}`),
  ];
  const viewerBinding = scope.bindings.length + 3;
  const viewerSelect = payload.viewerUserId
    ? `,
       EXISTS(SELECT 1 FROM ugc_submission_upvotes
         WHERE submission_id = s.id AND user_id = ?${viewerBinding} AND active = 1) AS viewer_upvoted,
       EXISTS(SELECT 1 FROM ugc_submission_flags
         WHERE submission_id = s.id AND user_id = ?${viewerBinding} AND active = 1) AS viewer_flagged`
    : "";
  const row = await db
    .prepare(
      `SELECT s.*,
       (SELECT COUNT(*) FROM ugc_submission_upvotes WHERE submission_id = s.id AND active = 1) AS upvote_count,
       (SELECT COUNT(*) FROM ugc_submission_flags WHERE submission_id = s.id AND active = 1) AS flag_count,
       u.uid AS submitter_uid,
       u.uid_number AS user_uid_number,
       u.uid_suffix AS user_uid_suffix,
       u.nickname AS user_nickname
       ${viewerSelect}
     FROM ugc_submissions s
     LEFT JOIN users u ON u.uid = s.user_id
     WHERE ${filters.join(" AND ")}`,
    )
    .bind(
      payload.id,
      payload.markerId,
      ...scope.bindings,
      ...(payload.viewerUserId ? [payload.viewerUserId] : []),
    )
    .first<Record<string, unknown>>();

  return row ? publicImageFromRow(row, payload.assetBaseUrl, payload.viewerUserId) : null;
}
