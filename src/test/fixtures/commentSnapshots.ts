import type { DatabaseSync } from "node:sqlite";

import type { SnapshotReviewStatus } from "@/repositories/submission/types";

export interface CommentSnapshotFixture {
  id: string;
  userId: string;
  markerId?: string;
  parentId?: string | null;
  depth?: number;
  snapshotId?: string;
  content?: string;
  reviewStatus?: SnapshotReviewStatus;
  createdAt?: string;
}

/** Explicit new-schema comment data; creation behavior is tested through HTTP. */
export function insertCommentSnapshot(sqlite: DatabaseSync, input: CommentSnapshotFixture): void {
  const createdAt = input.createdAt ?? "2026-09-10T00:00:00.000Z";
  sqlite
    .prepare(`INSERT INTO ugc_submissions
    (id,kind,poi_id,poi_hash,poi_type,user_id,parent_id,comment_depth,created_at,updated_at)
    VALUES (?,'comment',?,'hash','poi',?,?,?,?,?)`)
    .run(
      input.id,
      input.markerId ?? "marker-1",
      input.userId,
      input.parentId ?? null,
      input.depth ?? 0,
      createdAt,
      createdAt,
    );
  sqlite
    .prepare(`INSERT INTO ugc_snapshots
    (id,submission_id,kind,revision,content,review_status,creator_user_id,created_at)
    VALUES (?,?,'comment',1,?,?,?,?)`)
    .run(
      input.snapshotId ?? `snapshot-${input.id}`,
      input.id,
      input.content ?? `Content ${input.id}`,
      input.reviewStatus ?? "approved",
      input.userId,
      createdAt,
    );
}
