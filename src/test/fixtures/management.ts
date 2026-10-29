import type { SnapshotReviewStatus } from "@/repositories/submission/snapshotReads";

import { insertCommentSnapshot } from "./commentSnapshots";
import { insertImageSnapshot } from "./imageSnapshots";
import { createModerationTestFixture } from "./moderation";

export interface ManagementSubmissionFixture {
  id: string;
  userId?: string;
  kind?: "image" | "comment";
  markerId?: string;
  poiHash?: string;
  poiType?: string;
  snapshotId?: string;
  reviewStatus?: SnapshotReviewStatus;
  content?: string;
  filePath?: string;
  parentId?: string;
  depth?: number;
  createdAt?: string;
}
/** Explicit snapshot schema for management consumers, without switching defaults. */
export function createSnapshotModerationFixture() {
  const fixture = createModerationTestFixture();

  const sqlite = fixture.database.sqlite;
  function submission(input: ManagementSubmissionFixture): void {
    const seed = { ...input, userId: input.userId ?? "author" };
    if (input.kind === "image") {
      insertImageSnapshot(sqlite, { ...seed, kind: "image" });
    } else {
      insertCommentSnapshot(sqlite, seed);
      sqlite
        .prepare("UPDATE ugc_submissions SET poi_hash=?,poi_type=? WHERE id=?")
        .run(input.poiHash ?? "hash", input.poiType ?? "poi", input.id);
    }
  }
  function reviewAudits() {
    return sqlite
      .prepare(
        "SELECT snapshot_id,from_status,to_status,source,admin_user_id,note FROM ugc_snapshots_review_audit ORDER BY rowid",
      )
      .all();
  }
  return { ...fixture, submission, reviewAudits };
}
export type SnapshotModerationFixture = ReturnType<typeof createSnapshotModerationFixture>;
