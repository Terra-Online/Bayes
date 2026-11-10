import type { SubmissionStatus } from "./types";

interface CommentVersion {
  id: string;
  markerId: string;
  parentId: string | null;
  depth: number;
  snapshotId: string;
  status: SubmissionStatus;
}

export type AppendCommentResult =
  | { outcome: "appended" | "unchanged"; submission: CommentVersion }
  | { outcome: "not_found" }
  | { outcome: "unauthorized" }
  | { outcome: "conflict" };

interface EditState extends CommentVersion {
  content: string;
  authorized: number;
  eligible: number;
}

/** Eligibility, no-op classification and revision allocation share one serialized D1 batch.
 * snapshotId must be fresh for this attempt: its insertion is the receipt for advancing revision.
 */
export async function appendCommentVersion(
  db: D1Database,
  input: {
    submissionId: string;
    parentSnapshotId: string;
    snapshotId: string;
    actorId: string;
    content: string;
  },
): Promise<AppendCommentResult> {
  const now = new Date().toISOString();
  const authorized = `(s.user_id=?3 OR EXISTS (SELECT 1 FROM users WHERE uid=?3 AND role IN ('a','r')))`;
  const eligible = `f.id=?2 AND f.review_status='approved'
    AND s.author_deleted_at IS NULL AND s.admin_deleted_at IS NULL AND ${authorized}`;
  const [state, inserted] = await db.batch<EditState>([
    db
      .prepare(`SELECT s.id, s.poi_id AS markerId, s.parent_id AS parentId,
      s.comment_depth AS depth, f.id AS snapshotId, f.content,
      ${authorized} AS authorized, (${eligible}) AS eligible,
      CASE WHEN EXISTS (SELECT 1 FROM ugc_submission_flags g WHERE g.submission_id=s.id AND g.active=1)
        THEN 'flagged' ELSE 'active' END AS status
      FROM ugc_submissions s JOIN ugc_snapshots f ON f.submission_id=s.id AND f.revision=s.revision
      WHERE s.id=?1 AND s.kind='comment'`)
      .bind(input.submissionId, input.parentSnapshotId, input.actorId),
    db
      .prepare(`INSERT INTO ugc_snapshots
      (id,submission_id,kind,revision,content,review_status,creator_user_id,created_at)
      SELECT ?4,s.id,'comment',s.revision+1,?5,'pending_openai',?3,?6
      FROM ugc_submissions s JOIN ugc_snapshots f ON f.submission_id=s.id AND f.revision=s.revision
      WHERE s.id=?1 AND s.kind='comment' AND ${eligible} AND f.content<>?5
      RETURNING id`)
      .bind(
        input.submissionId,
        input.parentSnapshotId,
        input.actorId,
        input.snapshotId,
        input.content,
        now,
      ),
    db
      .prepare(`UPDATE ugc_submissions AS s SET revision=revision+1,updated_at=?3
      WHERE s.id=?1 AND EXISTS (SELECT 1 FROM ugc_snapshots n
        WHERE n.id=?2 AND n.submission_id=s.id AND n.revision=s.revision+1)`)
      .bind(input.submissionId, input.snapshotId, now),
  ]);
  const row = state.results[0];
  if (!row) {
    return { outcome: "not_found" };
  }
  if (!row.authorized) {
    return { outcome: "unauthorized" };
  }
  if (!row.eligible) {
    return { outcome: "conflict" };
  }
  const submission: CommentVersion = {
    id: row.id,
    markerId: row.markerId,
    parentId: row.parentId,
    depth: row.depth,
    snapshotId: row.snapshotId,
    status: row.status,
  };
  if (inserted.results.length === 0) {
    return { outcome: "unchanged", submission };
  }
  return {
    outcome: "appended",
    submission: { ...submission, snapshotId: input.snapshotId, status: "pending_openai" },
  };
}
