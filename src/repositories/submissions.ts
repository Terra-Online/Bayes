export interface SubmissionRecord {
  id: string;
  markerId: string;
  uid: string;
  content: string | null;
  imageR2Key: string;
  auditStatus: number;
  moderationNote: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapSubmission(row: Record<string, unknown>): SubmissionRecord {
  return {
    id: String(row.id),
    markerId: String(row.marker_id),
    uid: String(row.uid),
    content: row.content === null ? null : String(row.content ?? ""),
    imageR2Key: String(row.image_r2_key),
    auditStatus: Number(row.audit_status ?? 0),
    moderationNote: row.moderation_note === null ? null : String(row.moderation_note ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export async function createPendingSubmission(
  db: D1Database,
  payload: {
    id: string;
    markerId: string;
    uid: string;
    content?: string;
    imageR2Key: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ugc_submissions (id, marker_id, uid, content, image_r2_key, audit_status)
       VALUES (?1, ?2, ?3, ?4, ?5, 0)`
    )
    .bind(payload.id, payload.markerId, payload.uid, payload.content ?? null, payload.imageR2Key)
    .run();
}

export async function getPendingSubmissions(db: D1Database, limit = 50): Promise<SubmissionRecord[]> {
  const result = await db
    .prepare("SELECT * FROM ugc_submissions WHERE audit_status = 0 ORDER BY created_at ASC LIMIT ?1")
    .bind(limit)
    .all<Record<string, unknown>>();

  return (result.results ?? []).map((row) => mapSubmission(row));
}

export async function getSubmissionById(db: D1Database, id: string): Promise<SubmissionRecord | null> {
  const row = await db.prepare("SELECT * FROM ugc_submissions WHERE id = ?1 LIMIT 1").bind(id).first<Record<string, unknown>>();
  return row ? mapSubmission(row) : null;
}

export async function updateSubmissionStatus(
  db: D1Database,
  payload: {
    id: string;
    auditStatus: 1 | 2;
    moderationNote?: string;
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE ugc_submissions
       SET audit_status = ?2,
           moderation_note = ?3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?1`
    )
    .bind(payload.id, payload.auditStatus, payload.moderationNote ?? null)
    .run();
}
