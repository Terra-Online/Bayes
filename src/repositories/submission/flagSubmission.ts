import { formatPublicUid } from "@/repositories/users";

import { toCount } from "./mapper";
import type { SubmissionKind, SubmissionSubmitter } from "./types";

export type SetSubmissionReportResult =
  | { outcome: "missing" | "forbidden" | "conflict" }
  | {
      outcome: "committed";
      changed: boolean;
      flagCount: number;
      previousStatus: "active" | "flagged";
      submission: {
        id: string;
        snapshotId: string;
        kind: SubmissionKind;
        userId: string;
        markerId: string;
        poiHash: string;
        poiType: string;
        filePath: string | null;
        submitter: SubmissionSubmitter | null;
      };
    };

/** The clicked public version, write, no-op classification and count share a batch. */
export async function setSubmissionReport(
  db: D1Database,
  input: {
    submissionId: string;
    snapshotId: string;
    kind: SubmissionKind;
    userId: string;
    active: boolean;
  },
): Promise<SetSubmissionReportResult> {
  const eligible = `SELECT s.id FROM ugc_submissions s
    JOIN ugc_submission_visibility v ON v.submission_id=s.id
    WHERE s.id=?1 AND s.kind=?2 AND s.user_id<>?3 AND v.public_snapshot_id=?4`;
  const results = await db.batch<Record<string, unknown>>([
    db
      .prepare(`SELECT s.id, s.kind, s.user_id AS userId, s.poi_id AS markerId,
      s.poi_hash AS poiHash, s.poi_type AS poiType,
      v.public_snapshot_id AS snapshotId, r.file_path AS filePath,
      u.uid AS authorUid,u.uid_number AS uidNumber,u.uid_suffix AS uidSuffix,
      u.nickname,u.role,u.karma,u.avt AS avatar,
      (SELECT COUNT(*) FROM ugc_submission_flags WHERE submission_id=s.id AND active=1) AS flagCount
      FROM ugc_submissions s JOIN ugc_submission_visibility v ON v.submission_id=s.id
      LEFT JOIN ugc_snapshots r ON r.id=v.public_snapshot_id
      LEFT JOIN users u ON u.uid=s.user_id
      WHERE s.id=?1 AND s.kind=?2`)
      .bind(input.submissionId, input.kind),
    input.active
      ? db
          .prepare(`INSERT INTO ugc_submission_flags (submission_id,user_id,active)
          SELECT id,?3,1 FROM (${eligible}) WHERE 1
          ON CONFLICT(submission_id,user_id) DO UPDATE SET active=1
          WHERE ugc_submission_flags.active=0 RETURNING submission_id`)
          .bind(input.submissionId, input.kind, input.userId, input.snapshotId)
      : db
          .prepare(`UPDATE ugc_submission_flags SET active=0
          WHERE submission_id=?1 AND user_id=?3 AND active=1
            AND EXISTS (${eligible}) RETURNING submission_id`)
          .bind(input.submissionId, input.kind, input.userId, input.snapshotId),
    db
      .prepare(`SELECT COUNT(*) AS count FROM ugc_submission_flags
      WHERE submission_id=?1 AND active=1`)
      .bind(input.submissionId),
  ]);
  const row = results[0].results[0];
  if (!row) {
    return { outcome: "missing" };
  }
  if (row.userId === input.userId) {
    return { outcome: "forbidden" };
  }
  if (!row.snapshotId || row.snapshotId !== input.snapshotId) {
    return { outcome: "conflict" };
  }
  return {
    outcome: "committed",
    changed: results[1].results.length > 0,
    previousStatus: Number(row.flagCount) > 0 ? "flagged" : "active",
    flagCount: toCount(results[2].results[0]?.count),
    submission: {
      id: String(row.id),
      snapshotId: String(row.snapshotId),
      kind: input.kind,
      userId: String(row.userId),
      markerId: String(row.markerId),
      poiHash: String(row.poiHash),
      poiType: String(row.poiType),
      filePath: row.filePath === null ? null : String(row.filePath),
      submitter: row.authorUid
        ? {
            uid: String(row.authorUid),
            uidNumber: row.uidNumber === null ? null : Number(row.uidNumber),
            publicUid:
              row.uidNumber !== null && row.uidSuffix
                ? formatPublicUid(Number(row.uidNumber), String(row.uidSuffix))
                : null,
            nickname: row.nickname === null ? null : String(row.nickname),
            role: row.role === null ? null : String(row.role),
            karma: row.karma === null ? null : Number(row.karma),
            avatar: row.avatar === null ? null : Number(row.avatar),
          }
        : null,
    },
  };
}

export async function countSubmissionFlags(db: D1Database, submissionId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM ugc_submission_flags
       WHERE submission_id = ?1
         AND active = 1`,
    )
    .bind(submissionId)
    .first<{ count: number | string }>();

  return toCount(row?.count);
}

export async function clearSubmissionFlags(db: D1Database, submissionId: string): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE ugc_submission_flags
       SET active = 0
       WHERE submission_id = ?1
         AND active = 1`,
    )
    .bind(submissionId)
    .run();

  return result.meta.changes ?? 0;
}
