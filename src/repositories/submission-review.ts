import {
  ALL_STATUSES,
  type SubmissionKind,
  type SubmissionRecord,
  type SubmissionStatus
} from "./submission/types";
import {
  mapStatus,
  mapSubmission,
  toCount,
} from "./submission/mapper";

export interface ReviewSubmissionStats {
  total: number;
  byKind: { kind: SubmissionKind; count: number }[];
  byType: { type: string; count: number }[];
  byStatus: { status: SubmissionStatus; count: number }[];
}

type ReviewSubmissionFilters = {
  statuses?: SubmissionStatus[];
  createdFrom?: string;
  createdTo?: string;
};

export async function getReviewSubmissions(
  db: D1Database,
  payload: {
    statuses?: SubmissionStatus[];
    createdFrom?: string;
    createdTo?: string;
    limit?: number;
  } = {}
): Promise<SubmissionRecord[]> {
  const filters = buildReviewSubmissionWhere(payload);
  const limit = Math.min(Math.max(payload.limit ?? 1000, 1), 10000);
  const limitPlaceholder = filters.bindings.length + 1;
  const result = await db
    .prepare(
      `SELECT
         s.*,
         COALESCE(f.flag_count, 0) AS flag_count,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname
       FROM ugc_submissions s
       LEFT JOIN (
         SELECT submission_id, COUNT(*) AS flag_count
         FROM ugc_submission_flags
         WHERE active = 1
         GROUP BY submission_id
       ) f ON f.submission_id = s.id
       LEFT JOIN users u ON u.uid = s.user_id
       WHERE ${filters.whereSql}
       ORDER BY
         CASE s.status
           WHEN 'pending_openai' THEN 0
           WHEN 'pending_audit' THEN 0
           WHEN 'flagged' THEN 1
           WHEN 'remove_request' THEN 2
           WHEN 'active' THEN 3
           ELSE 1
         END,
         s.created_at ASC
       LIMIT ?${limitPlaceholder}`
    )
    .bind(...filters.bindings, limit)
    .all<Record<string, unknown>>();

  return (result.results ?? []).map((row) => mapSubmission(row));
}

export async function getReviewSubmissionStats(
  db: D1Database,
  payload: ReviewSubmissionFilters = {}
): Promise<ReviewSubmissionStats> {
  const filters = buildReviewSubmissionWhere(payload);
  const [totalRow, kindRows, typeRows, statusRows] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM ugc_submissions s
         WHERE ${filters.whereSql}`
      )
      .bind(...filters.bindings)
      .first<{ count: number | string }>(),
    db
      .prepare(
        `SELECT kind, COUNT(*) AS count
         FROM ugc_submissions s
         WHERE ${filters.whereSql}
         GROUP BY kind
         ORDER BY kind ASC`
      )
      .bind(...filters.bindings)
      .all<{ kind: string; count: number | string }>(),
    db
      .prepare(
        `SELECT COALESCE(NULLIF(poi_type, ''), 'unknown') AS type, COUNT(*) AS count
         FROM ugc_submissions s
         WHERE ${filters.whereSql}
         GROUP BY COALESCE(NULLIF(poi_type, ''), 'unknown')
         ORDER BY count DESC, type ASC`
      )
      .bind(...filters.bindings)
      .all<{ type: string; count: number | string }>(),
    db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM ugc_submissions s
         WHERE ${filters.whereSql}
         GROUP BY status`
      )
      .bind(...filters.bindings)
      .all<{ status: string; count: number | string }>()
  ]);

  return {
    total: toCount(totalRow?.count),
    byKind: (kindRows.results ?? [])
      .filter((row): row is { kind: SubmissionKind; count: number | string } => (
        row.kind === "image" || row.kind === "comment"
      ))
      .map((row) => ({
        kind: row.kind,
        count: toCount(row.count)
      })),
    byType: (typeRows.results ?? []).map((row) => ({
      type: String(row.type),
      count: toCount(row.count)
    })),
    byStatus: (statusRows.results ?? [])
      .map((row) => ({
        status: mapStatus(row.status),
        count: toCount(row.count)
      }))
      .filter((row) => ALL_STATUSES.includes(row.status))
  };
}

export async function listAllImageFilePaths(db: D1Database): Promise<string[]> {
  const filePaths: string[] = [];
  let cursor = "";

  for (;;) {
    const result = await db
      .prepare(
        `SELECT DISTINCT file_path
         FROM ugc_submissions
         WHERE kind = 'image'
           AND file_path IS NOT NULL
           AND file_path > ?1
         ORDER BY file_path ASC
         LIMIT 1000`
      )
      .bind(cursor)
      .all<{ file_path: string }>();
    const batch = (result.results ?? []).map((row) => row.file_path).filter(Boolean);
    filePaths.push(...batch);
    if (batch.length < 1000) {
      break;
    }
    cursor = batch[batch.length - 1];
  }

  return filePaths;
}

export async function markImageSubmissionsStaleByFilePathPrefix(
  db: D1Database,
  prefix: string,
  moderationNote: string
): Promise<{ changedRows: number; markerIds: string[] }> {
  const escapedPrefix = `${escapeLikePattern(prefix)}/%`;
  const result = await db
    .prepare(
      `UPDATE ugc_submissions
       SET status = 'stale',
           moderation_note = CASE
             WHEN moderation_note IS NULL OR TRIM(moderation_note) = '' THEN ?2
             ELSE moderation_note || ' ' || ?2
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE kind = 'image'
         AND file_path LIKE ?1 ESCAPE '\\'
         AND status <> 'stale'
       RETURNING poi_id`
    )
    .bind(escapedPrefix, moderationNote)
    .all<{ poi_id: string }>();
  const rows = result.results ?? [];

  return {
    changedRows: rows.length,
    markerIds: [...new Set(rows.map((row) => row.poi_id).filter(Boolean))]
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function buildReviewSubmissionWhere(payload: ReviewSubmissionFilters): { whereSql: string; bindings: string[] } {
  const statuses = payload.statuses?.length ? payload.statuses : ALL_STATUSES;
  const bindings: string[] = [...statuses];
  const clauses = [
    `s.status IN (${statuses.map((_, index) => `?${index + 1}`).join(", ")})`
  ];

  if (payload.createdFrom) {
    bindings.push(payload.createdFrom);
    clauses.push(`s.created_at >= ?${bindings.length}`);
  }

  if (payload.createdTo) {
    bindings.push(payload.createdTo);
    clauses.push(`s.created_at <= ?${bindings.length}`);
  }

  return {
    whereSql: clauses.join(" AND "),
    bindings
  };
}
