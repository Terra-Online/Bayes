/** Recover exact eligible versions, including images retaining their pre-cutover IDs. */
export async function getPendingAutomaticReviews(
  db: D1Database,
  limit: number,
  queuedBefore: string,
): Promise<Array<{ id: string; snapshotId: string }>> {
  const result = await db
    .prepare(`SELECT s.id,f.id AS snapshotId
    FROM ugc_snapshots f JOIN ugc_submissions s ON s.id=f.submission_id AND s.revision=f.revision
    WHERE f.review_status='pending_openai'
      AND s.author_deleted_at IS NULL AND s.admin_deleted_at IS NULL
      AND (f.moderation_queued_at IS NULL OR f.moderation_queued_at < ?2)
    ORDER BY f.created_at ASC,f.id ASC LIMIT ?1`)
    .bind(limit, queuedBefore)
    .all<{ id: string; snapshotId: string }>();
  return result.results ?? [];
}

/** Delivery bookkeeping must never reserve a newer version or a deleted submission. */
export async function markAutomaticReviewQueued(
  db: D1Database,
  input: { id: string; snapshotId: string; queuedAt: string },
): Promise<void> {
  await db
    .prepare(`UPDATE ugc_snapshots SET moderation_queued_at=?3
    WHERE id=?2 AND submission_id=?1 AND review_status='pending_openai'
      AND EXISTS (SELECT 1 FROM ugc_submissions s
        WHERE s.id=?1 AND s.revision=ugc_snapshots.revision
          AND s.author_deleted_at IS NULL AND s.admin_deleted_at IS NULL)`)
    .bind(input.id, input.snapshotId, input.queuedAt)
    .run();
}
