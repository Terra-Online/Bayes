import {
  ARCHIVE_PROGRESS_BITS_PER_ARCHIVE,
  ARCHIVE_PROGRESS_FORMAT_VERSION,
  emptyArchiveProgressState,
  type ArchiveProgressState
} from "./archiveModel";

export type ArchiveProgressSyncMutationRecord = {
  requestHash: string;
  responseJson: string;
  resultVersion: number;
};

type CommitArchiveProgressSyncOptions = {
  uid: string;
  mutationId: string;
  requestHash: string;
  responseJson: string;
  resultVersion: number;
  createdAt: number;
  progress?: ArchiveProgressState;
};

function parseArchiveIds(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? [...new Set(parsed.map((item) => String(item).trim()).filter(Boolean))]
      : [];
  } catch {
    return [];
  }
}

export async function getUserArchiveProgress(
  db: D1Database,
  uid: string
): Promise<ArchiveProgressState> {
  const row = await db.prepare(
    `SELECT version, marker, checksum, archive_index_hash, format_version,
            bits_per_archive, archive_count, retained_archive_ids, updated_at
     FROM user_archive_progress
     WHERE uid = ?1
     LIMIT 1`
  ).bind(uid).first<{
    version: number;
    marker: string;
    checksum: string;
    archive_index_hash: string;
    format_version: number;
    bits_per_archive: number;
    archive_count: number;
    retained_archive_ids: string;
    updated_at: number | null;
  }>();
  if (!row) return emptyArchiveProgressState();

  const checksum = String(row.checksum ?? "");
  return {
    version: Math.max(0, Number(row.version) || 0),
    revision: checksum,
    marker: String(row.marker ?? ""),
    checksum,
    archiveIndexHash: String(row.archive_index_hash ?? ""),
    formatVersion: Math.max(0, Number(row.format_version) || ARCHIVE_PROGRESS_FORMAT_VERSION),
    bitsPerArchive: Math.max(0, Number(row.bits_per_archive) || ARCHIVE_PROGRESS_BITS_PER_ARCHIVE),
    archiveCount: Math.max(0, Number(row.archive_count) || 0),
    retainedArchiveIds: parseArchiveIds(row.retained_archive_ids),
    updatedAt: row.updated_at === null ? null : Number(row.updated_at)
  };
}

export async function getArchiveProgressSyncMutation(
  db: D1Database,
  uid: string,
  mutationId: string
): Promise<ArchiveProgressSyncMutationRecord | null> {
  const row = await db.prepare(
    `SELECT request_hash, response_json, result_version
     FROM archive_progress_sync_mutations
     WHERE uid = ?1 AND mutation_id = ?2
     LIMIT 1`
  ).bind(uid, mutationId).first<{
    request_hash: string;
    response_json: string;
    result_version: number;
  }>();
  return row ? {
    requestHash: row.request_hash,
    responseJson: row.response_json,
    resultVersion: Number(row.result_version)
  } : null;
}

export async function commitArchiveProgressSync(
  db: D1Database,
  options: CommitArchiveProgressSyncOptions
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (options.progress) {
    statements.push(db.prepare(
      `INSERT INTO user_archive_progress
         (uid, version, marker, checksum, archive_index_hash, format_version,
          bits_per_archive, archive_count, retained_archive_ids, updated_at, last_mutation_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(uid) DO UPDATE SET
         version = excluded.version,
         marker = excluded.marker,
         checksum = excluded.checksum,
         archive_index_hash = excluded.archive_index_hash,
         format_version = excluded.format_version,
         bits_per_archive = excluded.bits_per_archive,
         archive_count = excluded.archive_count,
         retained_archive_ids = excluded.retained_archive_ids,
         updated_at = excluded.updated_at,
         last_mutation_id = excluded.last_mutation_id`
    ).bind(
      options.uid,
      options.progress.version,
      options.progress.marker,
      options.progress.checksum,
      options.progress.archiveIndexHash,
      options.progress.formatVersion,
      options.progress.bitsPerArchive,
      options.progress.archiveCount,
      JSON.stringify(options.progress.retainedArchiveIds),
      options.progress.updatedAt,
      options.mutationId
    ));
  }

  statements.push(db.prepare(
    `INSERT INTO archive_progress_sync_mutations
       (uid, mutation_id, request_hash, response_json, result_version, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(
    options.uid,
    options.mutationId,
    options.requestHash,
    options.responseJson,
    options.resultVersion,
    options.createdAt
  ));
  statements.push(db.prepare(
    "UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE uid = ?1"
  ).bind(options.uid));
  await db.batch(statements);
}
