import type { DatabaseSync } from "node:sqlite";

export type SubmissionFixture = {
  id: string;
  userId: string;
  kind?: "image" | "comment";
  markerId?: string;
  poiHash?: string;
  poiType?: string;
  snapshotId?: string;
  status?: string;
  content?: string | null;
  filePath?: string | null;
  parentId?: string | null;
  depth?: number;
  createdAt?: string;
  updatedAt?: string;
  mimeType?: string | null;
  moderationNote?: string | null;
};

export function insertSubmission(sqlite: DatabaseSync, input: SubmissionFixture) {
  const item = {
    kind: "comment",
    markerId: "marker-1",
    poiHash: "hash",
    poiType: "poi",
    snapshotId: `snapshot-${input.id}`,
    status: "active",
    content: `Content ${input.id}`,
    filePath: input.kind === "image" ? `images/${input.id}.webp` : null,
    parentId: null,
    depth: 0,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: input.createdAt ?? "2026-09-10T00:00:00.000Z",
    mimeType: input.kind === "image" ? "image/webp" : null,
    moderationNote: null,
    ...input,
  };
  sqlite
    .prepare(`INSERT INTO ugc_submissions
    (id, user_id, kind, poi_id, poi_hash, poi_type, snapshot_id, status, content,
     file_path, parent_id, comment_depth, created_at, updated_at, mime_type, moderation_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      item.id,
      item.userId,
      item.kind,
      item.markerId,
      item.poiHash,
      item.poiType,
      item.snapshotId,
      item.status,
      item.content,
      item.filePath,
      item.parentId,
      item.depth,
      item.createdAt,
      item.updatedAt,
      item.mimeType,
      item.moderationNote,
    );
  return item;
}
