import type { SnapshotReviewStatus } from "./snapshotReads";
import type { SubmissionKind, SubmissionStatus, SubmissionSubmitter } from "./types";

export interface ManagementSnapshot {
  snapshotId: string;
  revision: number;
  content: string | null;
  filePath: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  reviewStatus: SnapshotReviewStatus;
  createdAt: string;
}
export interface ManagementSubmission {
  id: string;
  kind: SubmissionKind;
  markerId: string;
  poiHash: string;
  poiType: string;
  userId: string;
  parentId: string | null;
  commentDepth: number;
  createdAt: string;
  updatedAt: string;
  snapshotId: string;
  reviewStatus: SnapshotReviewStatus;
  content: string | null;
  filePath: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  frontier: ManagementSnapshot;
  publicSnapshotId: string | null;
  publicSnapshot: ManagementSnapshot | null;
  reportSnapshotId: string;
  flagCount: number;
  authorDeletedAt: string | null;
  adminDeletedAt: string | null;
  adminDeletedBy: string | null;
  /** Derived archive/filter vocabulary; reviewStatus is the actual review fact. */
  status: SubmissionStatus;
  submitter: SubmissionSubmitter | null;
  latestReviewAudit: {
    id: string;
    snapshotId: string;
    fromStatus: SnapshotReviewStatus;
    toStatus: SnapshotReviewStatus;
    source: "ai" | "admin";
    adminUserId: string | null;
    note: string | null;
    createdAt: string;
  } | null;
}
export interface ManagementFilters {
  submissionId?: string;
  statuses?: SubmissionStatus[];
  mode?: "all" | "reports";
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
  offset?: number;
}
export interface ManagementPage {
  items: ManagementSubmission[];
  limit: number;
  offset: number;
  nextOffset: number | null;
  stats: {
    total: number;
    byKind: { kind: SubmissionKind; count: number }[];
    byType: { type: string; count: number }[];
    byStatus: { status: SubmissionStatus; count: number }[];
    byReviewStatus: { reviewStatus: SnapshotReviewStatus; count: number }[];
  };
}
interface ManagementCount {
  kind: SubmissionKind;
  poiType: string;
  status: SubmissionStatus;
  reviewStatus: SnapshotReviewStatus;
  count: number;
}
const snapshot = (
  alias: string,
) => `json_object('snapshotId',${alias}.id,'revision',${alias}.revision,
  'content',${alias}.content,'filePath',${alias}.file_path,'mimeType',${alias}.mime_type,
  'sizeBytes',${alias}.size_bytes,'reviewStatus',${alias}.review_status,'createdAt',${alias}.created_at)`;
// One coherent record selects frontier/public content and their IDs together.
const selection = `WITH management AS (SELECT
  s.id,s.kind,s.poi_id AS markerId,s.poi_hash AS poiHash,s.poi_type AS poiType,
  s.user_id AS userId,s.parent_id AS parentId,s.comment_depth AS commentDepth,
  s.created_at AS createdAt,s.updated_at AS updatedAt,
  f.id AS snapshotId,f.review_status AS reviewStatus,f.content,f.file_path AS filePath,
  f.mime_type AS mimeType,f.size_bytes AS sizeBytes,
  ${snapshot("f")} AS frontier,
  p.id AS publicSnapshotId,CASE WHEN p.id IS NULL THEN NULL ELSE ${snapshot("p")} END AS publicSnapshot,
  COALESCE(p.id,f.id) AS reportSnapshotId,
  (SELECT COUNT(*) FROM ugc_submission_flags g WHERE g.submission_id=s.id AND g.active=1) AS flagCount,
  s.author_deleted_at AS authorDeletedAt,s.admin_deleted_at AS adminDeletedAt,s.admin_deleted_by AS adminDeletedBy,
  CASE WHEN s.author_deleted_at IS NOT NULL OR s.admin_deleted_at IS NOT NULL
    OR f.review_status IN ('rejected','unknown') THEN 'stale'
    WHEN f.review_status IN ('pending_openai','pending_audit') THEN f.review_status
    WHEN EXISTS (SELECT 1 FROM ugc_submission_flags g WHERE g.submission_id=s.id AND g.active=1)
    THEN 'flagged' ELSE 'active' END AS status,
  CASE WHEN u.uid IS NULL THEN NULL ELSE json_object('uid',u.uid,'uidNumber',u.uid_number,
    'publicUid',CASE WHEN u.uid_number IS NOT NULL AND u.uid_suffix IS NOT NULL THEN CAST(u.uid_number AS TEXT)||u.uid_suffix ELSE NULL END,
    'role',u.role,'karma',u.karma,'nickname',u.nickname,'avatar',u.avt) END AS submitter,
  (SELECT json_object('id',a.id,'snapshotId',a.snapshot_id,'fromStatus',a.from_status,
    'toStatus',a.to_status,'source',a.source,'adminUserId',a.admin_user_id,'note',a.note,'createdAt',a.created_at)
    FROM ugc_snapshots_review_audit a WHERE a.snapshot_id=f.id ORDER BY a.rowid DESC LIMIT 1) AS latestReviewAudit
  FROM ugc_submissions s
  JOIN ugc_submission_visibility v ON v.submission_id=s.id
  JOIN ugc_snapshots f ON f.id=v.frontier_snapshot_id AND f.submission_id=s.id
  LEFT JOIN ugc_snapshots p ON p.id=v.public_snapshot_id AND p.submission_id=s.id
  LEFT JOIN users u ON u.uid=s.user_id)`;

type Row = Omit<
  ManagementSubmission,
  "frontier" | "publicSnapshot" | "submitter" | "latestReviewAudit"
> & {
  frontier: string;
  publicSnapshot: string | null;
  submitter: string | null;
  latestReviewAudit: string | null;
};
/** Direct lookup ignores queue filters/pagination. Report browsing deliberately
 * ignores queue statuses/dates, allowing older hidden reports to be discovered.
 * Offset pages are bounded and deterministic for an unchanged dataset.
 */
export async function listManagementSubmissions(
  db: D1Database,
  input: ManagementFilters,
): Promise<ManagementPage> {
  const clauses: string[] = [];
  const bindings: (string | number)[] = [];
  const add = (clause: string, value: string) => {
    bindings.push(value);
    clauses.push(`${clause} ?${bindings.length}`);
  };
  if (input.submissionId) {
    add("id =", input.submissionId);
  } else if (input.mode === "reports") {
    clauses.push("flagCount > 0");
  } else {
    if (input.statuses?.length) {
      const params = input.statuses.map((status) => {
        bindings.push(status);
        return `?${bindings.length}`;
      });
      clauses.push(`status IN (${params.join(",")})`);
    }
    if (input.createdFrom) {
      bindings.push(input.createdFrom);
      clauses.push(`julianday(createdAt) >= julianday(?${bindings.length})`);
    }
    if (input.createdTo) {
      bindings.push(input.createdTo);
      clauses.push(`julianday(createdAt) <= julianday(?${bindings.length})`);
    }
  }
  const where = clauses.length ? clauses.join(" AND ") : "1=1";
  const limit = input.submissionId ? 1 : Math.min(Math.max(input.limit ?? 1000, 1), 10000);
  const offset = input.submissionId ? 0 : Math.max(input.offset ?? 0, 0);
  const order =
    input.mode === "reports"
      ? "createdAt ASC,id ASC"
      : `
    CASE status WHEN 'pending_openai' THEN 0 WHEN 'pending_audit' THEN 0
      WHEN 'flagged' THEN 1 WHEN 'active' THEN 3 ELSE 1 END,createdAt ASC,id ASC`;
  const result = await db.batch([
    db
      .prepare(`${selection} SELECT * FROM management WHERE ${where}
      ORDER BY ${order} LIMIT ?${bindings.length + 1} OFFSET ?${bindings.length + 2}`)
      .bind(...bindings, limit, offset),
    db
      .prepare(`${selection} SELECT kind,poiType,status,reviewStatus,COUNT(*) AS count
      FROM management WHERE ${where} GROUP BY kind,poiType,status,reviewStatus`)
      .bind(...bindings),
  ]);
  const items = (result[0].results as unknown as Row[]).map((row) => ({
    ...row,
    frontier: JSON.parse(row.frontier) as ManagementSnapshot,
    publicSnapshot: row.publicSnapshot
      ? (JSON.parse(row.publicSnapshot) as ManagementSnapshot)
      : null,
    submitter: row.submitter ? (JSON.parse(row.submitter) as SubmissionSubmitter) : null,
    latestReviewAudit: row.latestReviewAudit
      ? (JSON.parse(row.latestReviewAudit) as ManagementSubmission["latestReviewAudit"])
      : null,
  }));
  const counts = result[1].results as unknown as ManagementCount[];
  const aggregate = <K extends "kind" | "poiType" | "status" | "reviewStatus">(key: K) => {
    const groups = new Map<ManagementCount[K], number>();
    for (const row of counts) {
      groups.set(row[key], (groups.get(row[key]) ?? 0) + row.count);
    }
    return [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, count }));
  };
  const total = counts.reduce((sum, row) => sum + row.count, 0);
  return {
    items,
    limit,
    offset,
    nextOffset: offset + items.length < total ? offset + items.length : null,
    stats: {
      total,
      byKind: aggregate("kind").map(({ value, count }) => ({ kind: value, count })),
      byType: aggregate("poiType")
        .map(({ value, count }) => ({ type: value, count }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
      byStatus: aggregate("status").map(({ value, count }) => ({ status: value, count })),
      byReviewStatus: aggregate("reviewStatus").map(({ value, count }) => ({
        reviewStatus: value,
        count,
      })),
    },
  };
}
