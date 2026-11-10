import { appendVersion } from "./appendVersion";

export async function appendCommentVersion(
  db: D1Database,
  input: {
    submissionId: string;
    parentSnapshotId: string;
    snapshotId: string;
    actorId: string;
    content: string;
  },
) {
  const result = await appendVersion(db, { ...input, mode: "owner_edit" });
  if (result.outcome === "appended" || result.outcome === "unchanged") {
    return { outcome: result.outcome, submission: result.submission };
  }
  return result;
}
