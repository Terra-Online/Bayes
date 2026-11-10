import { changeSubmissionDeletion } from "./lifecycle";
import type { SubmissionKind } from "./types";

export async function deleteByAuthor(
  db: D1Database,
  input: { submissionId: string; kind: SubmissionKind; authorId: string },
) {
  const result = await changeSubmissionDeletion(db, {
    submissionId: input.submissionId,
    kind: input.kind,
    actorId: input.authorId,
    action: "deleted",
    permission: "owner",
  });
  if (result.outcome === "missing") {
    return { outcome: "not_found" as const };
  }
  if (result.outcome === "forbidden") {
    return { outcome: "unauthorized" as const };
  }
  if (result.outcome === "conflict") {
    throw new Error("Owner deletion has no version precondition");
  }
  return {
    outcome: result.outcome === "committed" ? ("deleted" as const) : ("already_deleted" as const),
    markerId: result.target.markerId,
    deletedAt: result.target.deletedAt!,
    deletedBy: result.target.deletedBy,
    // Existing DELETE clients use this timestamp as their deletion acknowledgement.
    authorDeletedAt: result.target.deletedAt!,
  };
}
