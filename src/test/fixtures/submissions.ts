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
};

export interface SeededSubmission {
  id: string;
  userId: string;
  kind: "image" | "comment";
  markerId: string;
  poiHash: string;
  poiType: string;
  snapshotId: string;
  status: string;
  content: string | null;
  filePath: string | null;
  parentId: string | null;
  depth: number;
  createdAt: string;
  updatedAt: string;
  mimeType: string | null;
}

export function insertSubmission(sqlite: DatabaseSync, input: SubmissionFixture): SeededSubmission {
  const item: SeededSubmission = {
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
    ...input,
  };
  sqlite
    .prepare(`INSERT INTO ugc_submissions
    (id,user_id,kind,poi_id,poi_hash,poi_type,parent_id,comment_depth,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(
      item.id,
      item.userId,
      item.kind,
      item.markerId,
      item.poiHash,
      item.poiType,
      item.parentId,
      item.depth,
      item.createdAt,
      item.updatedAt,
    );
  // Compatibility DTO vocabulary in existing scenarios maps to explicit facts.
  // This fixture never synthesizes audit or deletion history.
  const reviewStatuses: Record<string, string> = {
    stale: "unknown",
    active: "approved",
    flagged: "approved",
  };
  const reviewStatus = reviewStatuses[item.status] ?? item.status;
  sqlite
    .prepare(`INSERT INTO ugc_snapshots
    (id,submission_id,kind,revision,content,file_path,mime_type,review_status,creator_user_id,created_at)
    VALUES (?,?,?,1,?,?,?,?,?,?)`)
    .run(
      item.snapshotId,
      item.id,
      item.kind,
      item.content,
      item.filePath,
      item.mimeType,
      reviewStatus,
      item.userId,
      item.createdAt,
    );
  return item;
}
