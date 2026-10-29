import type { DatabaseSync } from "node:sqlite";

import type { SnapshotReviewStatus } from "@/repositories/submission/types";

export interface ImageSnapshotFixture {
  id: string;
  userId: string;
  kind?: "image";
  markerId?: string;
  poiHash?: string;
  poiType?: string;
  snapshotId?: string;
  content?: string | null;
  filePath?: string;
  mimeType?: string | null;
  reviewStatus?: SnapshotReviewStatus;
  createdAt?: string;
}

/** Explicit new-schema data for image route tests; never changes the default database. */
export function insertImageSnapshot(sqlite: DatabaseSync, input: ImageSnapshotFixture): void {
  const createdAt = input.createdAt ?? "2026-09-10T00:00:00.000Z";
  sqlite
    .prepare(`INSERT INTO ugc_submissions (id,kind,poi_id,poi_hash,poi_type,user_id,created_at,updated_at)
    VALUES (?,'image',?,?,?,?,?,?)`)
    .run(
      input.id,
      input.markerId ?? "marker-1",
      input.poiHash ?? "hash",
      input.poiType ?? "poi",
      input.userId,
      createdAt,
      createdAt,
    );
  sqlite
    .prepare(`INSERT INTO ugc_snapshots (id,submission_id,kind,revision,content,file_path,mime_type,review_status,creator_user_id,created_at)
    VALUES (?,?,'image',1,?,?,?,?,?,?)`)
    .run(
      input.snapshotId ?? `snapshot-${input.id}`,
      input.id,
      input.content ?? null,
      input.filePath ?? `images/${input.id}.webp`,
      input.mimeType === undefined ? "image/webp" : input.mimeType,
      input.reviewStatus ?? "approved",
      input.userId,
      createdAt,
    );
}
