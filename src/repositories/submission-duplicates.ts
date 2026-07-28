import {
  buildImageScopeFilters,
} from "./submission/listImages";
import { imageStatusListSql, publicImageFromRow, toCount } from "./submission/mapper";
import type { PublicSubmissionImage, SubmissionStatus } from "./submission/types";

export interface DuplicateImageMarker {
  markerId: string;
  poiHash: string;
  poiType: string;
  imageCount: number;
  latestCreatedAt: string;
  latestImage: PublicSubmissionImage | null;
}

export interface DuplicateImageMarkerList {
  items: DuplicateImageMarker[];
  total: number;
}

export interface DuplicateMarkerImages {
  items: PublicSubmissionImage[];
  total: number;
}

const PUBLIC_IMAGE_STATUSES: SubmissionStatus[] = ["active", "flagged", "remove_request"];
const REVIEWABLE_IMAGE_STATUSES: SubmissionStatus[] = [
  "pending_openai",
  "pending_audit",
  "active",
  "flagged",
  "remove_request"
];
const PUBLIC_IMAGE_STATUS_SQL = imageStatusListSql(PUBLIC_IMAGE_STATUSES);
const REVIEWABLE_IMAGE_STATUS_SQL = imageStatusListSql(REVIEWABLE_IMAGE_STATUSES);

export async function getDuplicateImageMarkerSummary(
  db: D1Database,
  payload: {
    markerId: string;
    pathPrefix?: string;
    excludePathPrefix?: string;
  }
): Promise<{ markerId: string; imageCount: number } | null> {
  const markerId = payload.markerId.trim();
  if (!markerId) {
    return null;
  }

  const filters = [
    "poi_id = ?1",
    "kind = 'image'",
    `status IN (${REVIEWABLE_IMAGE_STATUS_SQL})`
  ];
  const scope = buildImageScopeFilters(payload, 1);
  filters.push(...scope.clauses);

  const row = await db
    .prepare(
      `SELECT poi_id, COUNT(*) AS image_count
       FROM ugc_submissions
       WHERE ${filters.join(" AND ")}
       GROUP BY poi_id
       HAVING COUNT(*) > 1
       LIMIT 1`
    )
    .bind(markerId, ...scope.bindings)
    .first<{ poi_id: string; image_count: number | string }>();

  return row
    ? {
        markerId: String(row.poi_id),
        imageCount: toCount(row.image_count)
      }
    : null;
}

export async function listDuplicateImageMarkers(
  db: D1Database,
  payload: {
    assetBaseUrl: string;
    limit?: number;
    offset?: number;
    pathPrefix?: string;
    excludePathPrefix?: string;
  }
): Promise<DuplicateImageMarkerList> {
  const limit = Math.min(Math.max(payload.limit ?? 50, 1), 100);
  const offset = Math.max(payload.offset ?? 0, 0);
  const baseFilters = [
    "kind = 'image'",
    `status IN (${PUBLIC_IMAGE_STATUS_SQL})`
  ];
  const scope = buildImageScopeFilters(payload);
  baseFilters.push(...scope.clauses);
  const baseWhere = baseFilters.join(" AND ");
  const limitBinding = scope.bindings.length + 1;
  const offsetBinding = scope.bindings.length + 2;

  const [rowsResult, totalRow] = await Promise.all([
    db
      .prepare(
        `WITH duplicate_markers AS (
           SELECT
             poi_id,
             COUNT(*) AS image_count,
             MAX(created_at) AS latest_created_at
           FROM ugc_submissions
           WHERE ${baseWhere}
           GROUP BY poi_id
           HAVING COUNT(*) > 1
           ORDER BY latest_created_at DESC, poi_id ASC
           LIMIT ?${limitBinding} OFFSET ?${offsetBinding}
         ),
         latest_images AS (
           SELECT
             s.*,
             ROW_NUMBER() OVER (
               PARTITION BY s.poi_id
               ORDER BY s.created_at DESC, s.id DESC
             ) AS row_number
           FROM ugc_submissions s
           INNER JOIN duplicate_markers dm ON dm.poi_id = s.poi_id
           WHERE s.${baseWhere}
         ),
         latest_visible_images AS (
           SELECT *
           FROM latest_images
           WHERE row_number = 1
         ),
         upvote_counts AS (
           SELECT submission_id, COUNT(*) AS upvote_count
           FROM ugc_submission_upvotes
           WHERE active = 1
             AND submission_id IN (SELECT id FROM latest_visible_images)
           GROUP BY submission_id
         ),
         flag_counts AS (
           SELECT submission_id, COUNT(*) AS flag_count
           FROM ugc_submission_flags
           WHERE active = 1
             AND submission_id IN (SELECT id FROM latest_visible_images)
           GROUP BY submission_id
         )
         SELECT
           dm.poi_id AS duplicate_poi_id,
           dm.image_count,
           dm.latest_created_at,
           li.*,
           COALESCE(v.upvote_count, 0) AS upvote_count,
           COALESCE(f.flag_count, 0) AS flag_count,
           u.uid AS submitter_uid,
           u.uid_number AS user_uid_number,
           u.uid_suffix AS user_uid_suffix,
           u.role AS user_role,
           u.karma AS user_karma,
           u.nickname AS user_nickname
         FROM duplicate_markers dm
         LEFT JOIN latest_visible_images li ON li.poi_id = dm.poi_id
         LEFT JOIN upvote_counts v ON v.submission_id = li.id
         LEFT JOIN flag_counts f ON f.submission_id = li.id
         LEFT JOIN users u ON u.uid = li.user_id
         ORDER BY dm.latest_created_at DESC, dm.poi_id ASC`
      )
      .bind(...scope.bindings, limit, offset)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM (
           SELECT poi_id
           FROM ugc_submissions
           WHERE ${baseWhere}
           GROUP BY poi_id
           HAVING COUNT(*) > 1
         ) duplicate_markers`
      )
      .bind(...scope.bindings)
      .first<{ count: number | string }>()
  ]);

  return {
    items: (rowsResult.results ?? []).map((row) => {
      const latestImage = row.id === null || row.id === undefined
        ? null
        : publicImageFromRow(row, payload.assetBaseUrl);
      return {
        markerId: String(row.duplicate_poi_id ?? row.poi_id),
        poiHash: row.poi_hash === null || row.poi_hash === undefined ? "" : String(row.poi_hash),
        poiType: row.poi_type === null || row.poi_type === undefined ? "" : String(row.poi_type),
        imageCount: toCount(row.image_count),
        latestCreatedAt: String(row.latest_created_at),
        latestImage
      };
    }),
    total: toCount(totalRow?.count)
  };
}

export async function listDuplicateMarkerImages(
  db: D1Database,
  payload: {
    markerId: string;
    assetBaseUrl: string;
    limit?: number;
    offset?: number;
    pathPrefix?: string;
    excludePathPrefix?: string;
    viewerUserId?: string;
  }
): Promise<DuplicateMarkerImages> {
  const markerId = payload.markerId.trim();
  if (!markerId) {
    return { items: [], total: 0 };
  }

  const limit = Math.min(Math.max(payload.limit ?? 100, 1), 200);
  const offset = Math.max(payload.offset ?? 0, 0);
  const filters = [
    "s.poi_id = ?1",
    "s.kind = 'image'",
    `s.status IN (${PUBLIC_IMAGE_STATUS_SQL})`
  ];
  const scope = buildImageScopeFilters(payload, 1);
  const scopedClauses = scope.clauses.map((clause) => `s.${clause}`);
  filters.push(...scopedClauses);
  const viewerBindingOffset = 1 + scope.bindings.length;
  const viewerSelect = payload.viewerUserId
    ? `,
         CASE WHEN uv.user_id IS NULL THEN 0 ELSE 1 END AS viewer_upvoted,
         CASE WHEN uf.user_id IS NULL THEN 0 ELSE 1 END AS viewer_flagged`
    : "";
  const viewerJoin = payload.viewerUserId
    ? `
       LEFT JOIN ugc_submission_upvotes uv ON uv.submission_id = s.id AND uv.user_id = ?${viewerBindingOffset + 1} AND uv.active = 1
       LEFT JOIN ugc_submission_flags uf ON uf.submission_id = s.id AND uf.user_id = ?${viewerBindingOffset + 2} AND uf.active = 1`
    : "";
  const viewerBindings = payload.viewerUserId ? [payload.viewerUserId, payload.viewerUserId] : [];
  const limitBinding = 1 + scope.bindings.length + viewerBindings.length + 1;
  const offsetBinding = limitBinding + 1;

  const [rowsResult, totalRow] = await Promise.all([
    db
      .prepare(
        `WITH selected_images AS (
           SELECT *
           FROM ugc_submissions s
           WHERE ${filters.join(" AND ")}
           ORDER BY s.created_at DESC, s.id DESC
           LIMIT ?${limitBinding} OFFSET ?${offsetBinding}
         ),
         upvote_counts AS (
           SELECT submission_id, COUNT(*) AS upvote_count
           FROM ugc_submission_upvotes
           WHERE active = 1
             AND submission_id IN (SELECT id FROM selected_images)
           GROUP BY submission_id
         ),
         flag_counts AS (
           SELECT submission_id, COUNT(*) AS flag_count
           FROM ugc_submission_flags
           WHERE active = 1
             AND submission_id IN (SELECT id FROM selected_images)
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
         ORDER BY s.created_at DESC, s.id DESC`
      )
      .bind(markerId, ...scope.bindings, ...viewerBindings, limit, offset)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM ugc_submissions s
         WHERE ${filters.join(" AND ")}`
      )
      .bind(markerId, ...scope.bindings)
      .first<{ count: number | string }>()
  ]);

  const total = toCount(totalRow?.count);
  if (total <= 1) {
    return { items: [], total };
  }

  return {
    items: (rowsResult.results ?? []).map((row) => publicImageFromRow(row, payload.assetBaseUrl, payload.viewerUserId)),
    total
  };
}
