import type { ManagementSnapshot } from "./managementReads";

export interface HistoryCursor {
  createdAt: string;
  id: string;
}
export interface HistoryEvent {
  id: string;
  object: "submission" | "snapshot" | "report";
  action: "created" | "reviewed" | "deleted" | "restored" | "activated" | "withdrawn" | "cleared";
  actorUserId: string | null;
  snapshotId: string | null;
  reporterUserId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  operationId: string | null;
  note: string | null;
  createdAt: string;
}
export interface HistoricalSnapshot extends ManagementSnapshot {
  creatorUserId: string;
  creationSource: "user" | "admin";
  baselineSnapshotId: string | null;
  sourceSnapshotId: string | null;
  note: string | null;
}

/** Current-state tables supply creation facts; audits explain subsequent changes. */
export async function listSubmissionHistory(
  db: D1Database,
  input: {
    submissionId: string;
    limit: number;
    cursor?: HistoryCursor;
    reportsOnly?: boolean;
    reporterUserId?: string;
  },
) {
  const reportEvents = `SELECT a.id,'report',a.action,a.actor_user_id,NULL,a.reporter_user_id,
    NULL,NULL,NULL,NULL,a.operation_id,a.note,a.created_at
    FROM ugc_submission_flag_audit a WHERE a.submission_id=?1`;
  const events = input.reportsOnly
    ? reportEvents
    : `
    SELECT 'submission:'||s.id,'submission','created',s.user_id,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,s.created_at
    FROM ugc_submissions s WHERE s.id=?1
    UNION ALL SELECT 'snapshot:'||f.id,'snapshot','created',f.creator_user_id,f.id,NULL,NULL,NULL,NULL,NULL,NULL,f.edit_note,f.created_at
    FROM ugc_snapshots f WHERE f.submission_id=?1
    UNION ALL SELECT a.id,'submission',a.action,a.actor_user_id,NULL,NULL,NULL,NULL,a.deleted_at,a.deleted_by,NULL,a.note,a.created_at
    FROM ugc_submission_audit a WHERE a.submission_id=?1
    UNION ALL SELECT a.id,'snapshot','reviewed',a.admin_user_id,f.id,NULL,a.from_status,a.to_status,NULL,NULL,NULL,a.note,a.created_at
    FROM ugc_snapshots_review_audit a JOIN ugc_snapshots f ON f.id=a.snapshot_id WHERE f.submission_id=?1
    UNION ALL ${reportEvents}`;
  const result = await db
    .prepare(`WITH events(id,object,action,actorUserId,snapshotId,reporterUserId,
    fromStatus,toStatus,deletedAt,deletedBy,operationId,note,createdAt) AS (${events})
    SELECT * FROM events WHERE (?2 IS NULL OR (julianday(createdAt),id)<(julianday(?2),?3))
      AND (?4 IS NULL OR reporterUserId=?4)
    ORDER BY julianday(createdAt) DESC,id DESC LIMIT ?5`)
    .bind(
      input.submissionId,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
      input.reporterUserId ?? null,
      input.limit + 1,
    )
    .all<HistoryEvent>();
  const items = result.results.slice(0, input.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      result.results.length > input.limit && last
        ? btoa(JSON.stringify({ createdAt: last.createdAt, id: last.id }))
        : null,
  };
}

export async function listHistoricalSnapshots(
  db: D1Database,
  input: { submissionId: string; limit: number; beforeRevision?: number },
) {
  const result = await db
    .prepare(`SELECT id AS snapshotId,revision,content,file_path AS filePath,
    mime_type AS mimeType,size_bytes AS sizeBytes,review_status AS reviewStatus,
    review_version AS reviewVersion,creator_user_id AS creatorUserId,creation_source AS creationSource,
    baseline_snapshot_id AS baselineSnapshotId,source_snapshot_id AS sourceSnapshotId,
    edit_note AS note,created_at AS createdAt
    FROM ugc_snapshots WHERE submission_id=?1 AND (?2 IS NULL OR revision<?2)
    ORDER BY revision DESC LIMIT ?3`)
    .bind(input.submissionId, input.beforeRevision ?? null, input.limit + 1)
    .all<HistoricalSnapshot>();
  const items = result.results.slice(0, input.limit);
  return {
    items,
    nextBeforeRevision: result.results.length > input.limit ? items.at(-1)!.revision : null,
  };
}

export async function getHistoricalImage(db: D1Database, submissionId: string, snapshotId: string) {
  return db
    .prepare(`SELECT file_path AS filePath,mime_type AS mimeType FROM ugc_snapshots
    WHERE submission_id=?1 AND id=?2 AND kind='image'`)
    .bind(submissionId, snapshotId)
    .first<{ filePath: string; mimeType: string | null }>();
}

export async function submissionExists(db: D1Database, id: string): Promise<boolean> {
  return Boolean(await db.prepare("SELECT id FROM ugc_submissions WHERE id=?1").bind(id).first());
}
