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
  const { content, ...version } = input;
  const result = await appendVersion(db, {
    ...version,
    mode: "owner_edit",
    change: { type: "text", content },
  });
  if (result.outcome === "appended" || result.outcome === "unchanged") {
    return { outcome: result.outcome, submission: result.submission };
  }
  return result;
}
