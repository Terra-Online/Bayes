import {
  ALL_STATUSES,
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
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname
       FROM ugc_submissions s
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
  const [totalRow, typeRows, statusRows] = await Promise.all([
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

export async function deleteSubmissionsByFilePathPrefix(db: D1Database, prefix: string): Promise<number> {
  const escapedPrefix = `${prefix.replace(/%/g, "\\%")}/%`;
  await db
    .prepare(
      `DELETE FROM ugc_submission_upvotes
       WHERE submission_id IN (
         SELECT id
         FROM ugc_submissions
         WHERE kind = 'image'
           AND file_path LIKE ?1
       )`
    )
    .bind(escapedPrefix)
    .run();
  await db
    .prepare(
      `DELETE FROM ugc_submission_flags
       WHERE submission_id IN (
         SELECT id
         FROM ugc_submissions
         WHERE kind = 'image'
           AND file_path LIKE ?1
       )`
    )
    .bind(escapedPrefix)
    .run();

  const result = await db
    .prepare("DELETE FROM ugc_submissions WHERE kind = 'image' AND file_path LIKE ?1")
    .bind(escapedPrefix)
    .run();

  return result.meta.changes ?? 0;
}

export async function getSubmissionFilePathsByStatus(
  db: D1Database,
  status: SubmissionStatus,
  limit = 1000,
  offset = 0
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT file_path
       FROM ugc_submissions
       WHERE kind = 'image'
         AND file_path IS NOT NULL
         AND status = ?1
       ORDER BY created_at ASC
       LIMIT ?2 OFFSET ?3`
    )
    .bind(status, Math.min(Math.max(limit, 1), 1000), Math.max(offset, 0))
    .all<{ file_path: string }>();

  return (result.results ?? [])
    .map((row) => row.file_path)
    .filter(Boolean);
}

export async function deleteSubmissionsByStatus(db: D1Database, status: SubmissionStatus): Promise<number> {
  await db
    .prepare(
      `DELETE FROM ugc_submission_upvotes
       WHERE submission_id IN (
         SELECT id
         FROM ugc_submissions
         WHERE status = ?1
       )`
    )
    .bind(status)
    .run();
  await db
    .prepare(
      `DELETE FROM ugc_submission_flags
       WHERE submission_id IN (
         SELECT id
         FROM ugc_submissions
         WHERE status = ?1
       )`
    )
    .bind(status)
    .run();

  const result = await db
    .prepare("DELETE FROM ugc_submissions WHERE status = ?1")
    .bind(status)
    .run();

  return result.meta.changes ?? 0;
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
