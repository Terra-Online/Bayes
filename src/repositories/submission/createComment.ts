export interface NewCommentSubmission {
  id: string;
  snapshotId: string;
  userId: string;
  markerId: string;
  poiHash: string;
  poiType: string;
  content: string;
  parentId?: string;
}

export type CreateCommentResult =
  | { outcome: "created"; id: string; snapshotId: string; parentId: string | null; depth: number }
  | { outcome: "parent_missing" | "parent_mismatch" | "parent_hidden" };

/** Parent eligibility is evaluated by INSERT, in the same batch as the first version. */
export async function createPendingComment(
  db: D1Database,
  input: NewCommentSubmission,
): Promise<CreateCommentResult> {
  const createdAt = new Date().toISOString();
  const identity = input.parentId
    ? db
        .prepare(`INSERT INTO ugc_submissions
      (id,kind,poi_id,poi_hash,poi_type,user_id,parent_id,comment_depth,revision,created_at,updated_at)
      SELECT ?1,'comment',?2,?3,?4,?5,p.id,p.comment_depth+1,1,?6,?6
      FROM ugc_submissions p
      JOIN v_ugc_submission_visibility v ON v.submission_id=p.id
      WHERE p.id=?7 AND p.kind='comment' AND p.poi_id=?2 AND p.poi_hash=?3 AND p.poi_type=?4
        AND v.public_snapshot_id IS NOT NULL
      RETURNING parent_id,comment_depth`)
        .bind(
          input.id,
          input.markerId,
          input.poiHash,
          input.poiType,
          input.userId,
          createdAt,
          input.parentId,
        )
    : db
        .prepare(`INSERT INTO ugc_submissions
      (id,kind,poi_id,poi_hash,poi_type,user_id,revision,created_at,updated_at)
      VALUES (?1,'comment',?2,?3,?4,?5,1,?6,?6)
      RETURNING parent_id,comment_depth`)
        .bind(input.id, input.markerId, input.poiHash, input.poiType, input.userId, createdAt);
  const results = await db.batch<Record<string, unknown>>([
    identity,
    db
      .prepare(`INSERT INTO ugc_snapshots
      (id,submission_id,kind,revision,content,review_status,creator_user_id,created_at)
      SELECT ?1,id,'comment',1,?3,'pending_openai',?4,?5
      FROM ugc_submissions WHERE id=?2`)
      .bind(input.snapshotId, input.id, input.content, input.userId, createdAt),
    ...(input.parentId
      ? [
          db
            .prepare(`SELECT poi_id,poi_hash,poi_type FROM ugc_submissions
      WHERE id=?1 AND kind='comment'`)
            .bind(input.parentId),
        ]
      : []),
  ]);
  const row = results[0].results[0];
  if (row) {
    return {
      outcome: "created",
      id: input.id,
      snapshotId: input.snapshotId,
      parentId: row.parent_id as string | null,
      depth: Number(row.comment_depth),
    };
  }
  const parent = results[2]?.results[0];
  if (!parent) {
    return { outcome: "parent_missing" };
  }
  if (
    parent.poi_id !== input.markerId ||
    parent.poi_hash !== input.poiHash ||
    parent.poi_type !== input.poiType
  ) {
    return { outcome: "parent_mismatch" };
  }
  return { outcome: "parent_hidden" };
}

/** Delivery failure leaves this pending version unmarked for the later backfill. */
export async function markCommentModerationQueued(
  db: D1Database,
  input: { submissionId: string; snapshotId: string; queuedAt: string },
): Promise<void> {
  await db
    .prepare(`UPDATE ugc_snapshots SET moderation_queued_at=?3
    WHERE id=?2 AND submission_id=?1 AND kind='comment' AND review_status='pending_openai'`)
    .bind(input.submissionId, input.snapshotId, input.queuedAt)
    .run();
}
