import type { UserProgressWrite } from "../../repositories/users";
import type { ProgressStatsDelta } from "./model";

export type ProgressSyncMutationRecord = {
  requestHash: string;
  responseJson: string;
  resultVersion: number;
  createdAt: number;
};

export type ProgressStatsOutboxRecord = {
  id: number;
  eventId: string;
  uid: string;
  mutationId: string;
  markerIndexHash: string;
  payload: ProgressStatsDelta;
  attempts: number;
  createdAt: number;
};

type CommitProgressSyncOptions = {
  uid: string;
  mutationId: string;
  requestHash: string;
  responseJson: string;
  resultVersion: number;
  createdAt: number;
  progress?: UserProgressWrite;
  statsEvent?: ProgressStatsDelta;
};

const MUTATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const PROCESSED_OUTBOX_RETENTION_MS = 45 * 24 * 60 * 60 * 1_000;

export async function getProgressSyncMutation(
  db: D1Database,
  uid: string,
  mutationId: string
): Promise<ProgressSyncMutationRecord | null> {
  const row = await db
    .prepare(
      `SELECT request_hash, response_json, result_version, created_at
       FROM progress_sync_mutations
       WHERE uid = ?1 AND mutation_id = ?2
       LIMIT 1`
    )
    .bind(uid, mutationId)
    .first<{
      request_hash: string;
      response_json: string;
      result_version: number;
      created_at: number;
    }>();

  return row
    ? {
      requestHash: row.request_hash,
      responseJson: row.response_json,
      resultVersion: Number(row.result_version),
      createdAt: Number(row.created_at)
    }
    : null;
}

function prepareProgressUpdate(
  db: D1Database,
  uid: string,
  progress: UserProgressWrite
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users
       SET progress_version = ?2,
           progress_marker = ?3,
           progress_checksum = ?4,
           progress_marker_index_hash = ?5,
           progress_format_version = ?6,
           progress_bits_per_point = ?7,
           progress_point_count = ?8,
           progress_retained_point_ids = ?9,
           progress_updated_at = ?10,
           progress_last_mutation_id = ?11,
           progress_cloud_synced = ?12,
           progress_synced_at = COALESCE(?13, progress_synced_at),
           last_active = CURRENT_TIMESTAMP
       WHERE uid = ?1`
    )
    .bind(
      uid,
      progress.version,
      progress.marker,
      progress.checksum,
      progress.markerIndexHash,
      progress.formatVersion,
      progress.bitsPerPoint,
      progress.pointCount,
      JSON.stringify(progress.retainedPointIds),
      progress.updatedAt,
      progress.clientMutationId,
      progress.cloudSynced ? 1 : 0,
      progress.syncedAt
    );
}

export async function commitProgressSync(
  db: D1Database,
  options: CommitProgressSyncOptions
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (options.progress) {
    statements.push(prepareProgressUpdate(db, options.uid, options.progress));
  }

  statements.push(
    db.prepare(
      `INSERT INTO progress_sync_mutations
         (uid, mutation_id, request_hash, response_json, result_version, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(
      options.uid,
      options.mutationId,
      options.requestHash,
      options.responseJson,
      options.resultVersion,
      options.createdAt
    )
  );

  if (options.statsEvent) {
    statements.push(
      db.prepare(
        `INSERT INTO progress_stats_outbox
           (event_id, uid, mutation_id, marker_index_hash, payload, status, attempts,
            next_attempt_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?6)`
      ).bind(
        options.statsEvent.eventId,
        options.uid,
        options.mutationId,
        options.statsEvent.markerIndexHash,
        JSON.stringify(options.statsEvent),
        options.createdAt
      )
    );
  }

  await db.batch(statements);
}

function mapOutboxRow(row: Record<string, unknown>): ProgressStatsOutboxRecord {
  const payload = JSON.parse(String(row.payload)) as ProgressStatsDelta;
  return {
    id: Number(row.id),
    eventId: String(row.event_id),
    uid: String(row.uid),
    mutationId: String(row.mutation_id),
    markerIndexHash: String(row.marker_index_hash),
    payload,
    attempts: Number(row.attempts ?? 0),
    createdAt: Number(row.created_at)
  };
}

const OUTBOX_SELECT = `
  SELECT event.id, event.event_id, event.uid, event.mutation_id,
         event.marker_index_hash, event.payload, event.attempts, event.created_at
  FROM progress_stats_outbox event
  WHERE event.status IN ('pending', 'retry')
    AND event.next_attempt_at <= ?1
    AND NOT EXISTS (
      SELECT 1
      FROM progress_stats_outbox earlier
      WHERE earlier.uid = event.uid
        AND earlier.id < event.id
        AND earlier.status <> 'processed'
    )`;

export async function listDispatchableProgressStatsEvents(
  db: D1Database,
  now: number,
  limit: number,
  uid?: string
): Promise<ProgressStatsOutboxRecord[]> {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const uidClause = uid ? " AND event.uid = ?3" : "";
  const statement = db.prepare(
    `${OUTBOX_SELECT}${uidClause}
     ORDER BY event.next_attempt_at ASC, event.id ASC
     LIMIT ?2`
  );
  const result = uid
    ? await statement.bind(now, boundedLimit, uid).all<Record<string, unknown>>()
    : await statement.bind(now, boundedLimit).all<Record<string, unknown>>();
  return (result.results ?? []).map(mapOutboxRow);
}

export async function markProgressStatsEventProcessed(
  db: D1Database,
  eventId: string,
  processedAt: number
): Promise<void> {
  await db.prepare(
    `UPDATE progress_stats_outbox
     SET status = 'processed', processed_at = ?2, last_error = NULL
     WHERE event_id = ?1 AND status <> 'processed'`
  ).bind(eventId, processedAt).run();
}

export async function markProgressStatsEventFailed(
  db: D1Database,
  options: {
    eventId: string;
    blocked: boolean;
    attempts: number;
    nextAttemptAt: number;
    error: string;
  }
): Promise<void> {
  await db.prepare(
    `UPDATE progress_stats_outbox
     SET status = ?2,
         attempts = ?3,
         next_attempt_at = ?4,
         last_error = ?5
     WHERE event_id = ?1 AND status <> 'processed'`
  ).bind(
    options.eventId,
    options.blocked ? "blocked" : "retry",
    options.attempts,
    options.nextAttemptAt,
    options.error.slice(0, 2_000)
  ).run();
}

export async function cleanupProgressConsistencyRecords(
  db: D1Database,
  now: number
): Promise<void> {
  await db.batch([
    db.prepare(
      `DELETE FROM progress_sync_mutations
       WHERE rowid IN (
         SELECT rowid FROM progress_sync_mutations
         WHERE created_at < ?1
         ORDER BY created_at ASC
         LIMIT 500
       )`
    ).bind(now - MUTATION_RETENTION_MS),
    db.prepare(
      `DELETE FROM progress_stats_outbox
       WHERE id IN (
         SELECT id FROM progress_stats_outbox
         WHERE status = 'processed' AND processed_at < ?1
         ORDER BY processed_at ASC
         LIMIT 500
       )`
    ).bind(now - PROCESSED_OUTBOX_RETENTION_MS),
    db.prepare(
      `DELETE FROM archive_progress_sync_mutations
       WHERE rowid IN (
         SELECT rowid FROM archive_progress_sync_mutations
         WHERE created_at < ?1
         ORDER BY created_at ASC
         LIMIT 500
       )`
    ).bind(now - MUTATION_RETENTION_MS)
  ]);
}

export async function getProgressStatsOutboxHealth(
  db: D1Database,
  now: number
): Promise<{
  pending: number;
  blocked: number;
  oldestAgeMs: number;
}> {
  const row = await db.prepare(
    `SELECT
       SUM(CASE WHEN status IN ('pending', 'retry') THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
       MIN(CASE WHEN status IN ('pending', 'retry') THEN created_at ELSE NULL END) AS oldest_created_at
     FROM progress_stats_outbox`
  ).first<{
    pending: number | null;
    blocked: number | null;
    oldest_created_at: number | null;
  }>();
  const oldestCreatedAt = Number(row?.oldest_created_at ?? now);
  return {
    pending: Number(row?.pending ?? 0),
    blocked: Number(row?.blocked ?? 0),
    oldestAgeMs: row?.oldest_created_at === null || row?.oldest_created_at === undefined
      ? 0
      : Math.max(0, now - oldestCreatedAt)
  };
}
