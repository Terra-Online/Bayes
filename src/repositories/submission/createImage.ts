export interface NewImageSubmission {
  id: string;
  snapshotId: string;
  userId: string;
  markerId: string;
  poiHash: string;
  poiType: string;
  content?: string;
  filePath: string;
  mimeType: string;
  sizeBytes: number;
}

/** Identity and first immutable version succeed or roll back together in D1. */
export async function createPendingImage(db: D1Database, image: NewImageSubmission): Promise<void> {
  const createdAt = new Date().toISOString();
  await db.batch([
    db
      .prepare(`INSERT INTO ugc_submissions
      (id,kind,poi_id,poi_hash,poi_type,user_id,revision,created_at,updated_at)
      VALUES (?1,'image',?2,?3,?4,?5,1,?6,?6)`)
      .bind(image.id, image.markerId, image.poiHash, image.poiType, image.userId, createdAt),
    db
      .prepare(`INSERT INTO ugc_snapshots
      (id,submission_id,kind,revision,content,file_path,mime_type,size_bytes,review_status,creator_user_id,created_at)
      VALUES (?1,?2,'image',1,?3,?4,?5,?6,'pending_openai',?7,?8)`)
      .bind(
        image.snapshotId,
        image.id,
        image.content ?? null,
        image.filePath,
        image.mimeType,
        image.sizeBytes,
        image.userId,
        createdAt,
      ),
  ]);
}

/** Called only after delivery. A failed delivery leaves the version eligible for backfill. */
export async function markImageModerationQueued(
  db: D1Database,
  input: { submissionId: string; snapshotId: string; queuedAt: string },
): Promise<void> {
  await db
    .prepare(`UPDATE ugc_snapshots SET moderation_queued_at=?3
    WHERE id=?2 AND submission_id=?1 AND kind='image' AND review_status='pending_openai'`)
    .bind(input.submissionId, input.snapshotId, input.queuedAt)
    .run();
}
