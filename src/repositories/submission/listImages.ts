import { mapSubmission, publicImageFromRow, toCount } from "./mapper";
import type { PublicSubmissionImage, UserSubmissionImage } from "./types";

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
