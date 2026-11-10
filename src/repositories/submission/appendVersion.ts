import type { SubmissionKind, SubmissionStatus } from "./types";

interface Version {
  id: string;
  markerId: string;
  parentId: string | null;
  depth: number;
  snapshotId: string;
  status: SubmissionStatus;
}
export type AppendVersionResult =
  | {
      outcome: "appended" | "unchanged";
      submission: Version;
      kind: SubmissionKind;
      deletedAt: string | null;
    }
  | { outcome: "not_found" }
  | { outcome: "unauthorized" }
  | { outcome: "conflict" };

/** Baseline, permission, no-op and revision allocation share one serialized batch. */
export async function appendVersion(
  db: D1Database,
  input: {
    submissionId: string;
    parentSnapshotId: string;
    snapshotId: string;
    actorId: string;
    mode: "owner_edit" | "admin";
    content?: string;
    sourceSnapshotId?: string;
    note?: string;
  },
): Promise<AppendVersionResult> {
  const now = new Date().toISOString();
  const admin = "EXISTS (SELECT 1 FROM users WHERE uid=?3 AND role IN ('a','r'))";
  const authorized = input.mode === "admin" ? admin : `(s.user_id=?3 OR ${admin})`;
  const eligible =
    `f.id=?2 AND ${authorized} AND ` +
    (input.mode === "admin"
      ? "f.review_status NOT IN ('pending_openai','pending_audit')"
      : "s.kind='comment' AND s.deleted_at IS NULL AND f.review_status='approved'");
  const source =
    "LEFT JOIN ugc_snapshots original ON original.id=?7 AND original.submission_id=s.id";
  const content = "CASE WHEN ?7 IS NOT NULL THEN original.content ELSE ?5 END";
  const args = [
    input.submissionId,
    input.parentSnapshotId,
    input.actorId,
    input.snapshotId,
    input.content ?? null,
    now,
    input.sourceSnapshotId ?? null,
    input.note ?? null,
  ];
  const results = await db.batch([
    db
      .prepare(`SELECT s.id,s.kind,s.poi_id AS markerId,s.parent_id AS parentId,
      s.comment_depth AS depth,s.deleted_at AS deletedAt,f.id AS snapshotId,
      (${authorized}) AS authorized,(${eligible} AND (?4 IS NULL OR original.id IS NOT NULL)) AS eligible,
      CASE WHEN s.deleted_at IS NOT NULL OR f.review_status IN ('rejected','unknown') THEN 'stale'
        WHEN EXISTS (SELECT 1 FROM ugc_submission_flags g WHERE g.submission_id=s.id AND g.active=1)
        THEN 'flagged' ELSE 'active' END AS status
      FROM ugc_submissions s JOIN ugc_snapshots f ON f.submission_id=s.id AND f.revision=s.revision
      ${source.replace("?7", "?4")} WHERE s.id=?1 ${input.mode === "owner_edit" ? "AND s.kind='comment'" : ""}`)
      .bind(
        input.submissionId,
        input.parentSnapshotId,
        input.actorId,
        input.sourceSnapshotId ?? null,
      ),
    db
      .prepare(`INSERT INTO ugc_snapshots
      (id,submission_id,kind,revision,content,file_path,mime_type,size_bytes,review_status,
       creator_user_id,created_at,baseline_snapshot_id,source_snapshot_id,edit_note,creation_source)
      SELECT ?4,s.id,s.kind,s.revision+1,${content},
        CASE WHEN ?7 IS NOT NULL THEN original.file_path ELSE f.file_path END,
        CASE WHEN ?7 IS NOT NULL THEN original.mime_type ELSE f.mime_type END,
        CASE WHEN ?7 IS NOT NULL THEN original.size_bytes ELSE f.size_bytes END,
        'pending_openai',?3,?6,f.id,?7,?8,CASE WHEN ${admin} THEN 'admin' ELSE 'user' END
      FROM ugc_submissions s JOIN ugc_snapshots f ON f.submission_id=s.id AND f.revision=s.revision
      ${source} WHERE s.id=?1 AND ${eligible} AND (?7 IS NULL OR original.id IS NOT NULL)
        AND (?7 IS NOT NULL OR f.content IS NOT ?5) RETURNING id`)
      .bind(...args),
    db
      .prepare(`UPDATE ugc_submissions AS s SET revision=revision+1,updated_at=?3
      WHERE s.id=?1 AND EXISTS (SELECT 1 FROM ugc_snapshots n
        WHERE n.id=?2 AND n.submission_id=s.id AND n.revision=s.revision+1)`)
      .bind(input.submissionId, input.snapshotId, now),
  ]);
  const row = results[0].results[0] as
    | (Version & {
        kind: SubmissionKind;
        deletedAt: string | null;
        authorized: number;
        eligible: number;
      })
    | undefined;
  if (!row) {
    return { outcome: "not_found" };
  }
  if (!row.authorized) {
    return { outcome: "unauthorized" };
  }
  if (!row.eligible) {
    return { outcome: "conflict" };
  }
  const appended = results[1].results.length > 0;
  return {
    outcome: appended ? "appended" : "unchanged",
    kind: row.kind,
    deletedAt: row.deletedAt,
    submission: {
      id: row.id,
      markerId: row.markerId,
      parentId: row.parentId,
      depth: row.depth,
      snapshotId: appended ? input.snapshotId : row.snapshotId,
      status: appended ? "pending_openai" : row.status,
    },
  };
}

export async function getSubmissionKind(db: D1Database, id: string) {
  return db
    .prepare("SELECT kind FROM ugc_submissions WHERE id=?1")
    .bind(id)
    .first<{ kind: SubmissionKind }>();
}
