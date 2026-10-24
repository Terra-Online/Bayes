import { ApiError } from "@/lib/errors";
import { getSubmissionById } from "@/repositories/submission/statusSubmission";
import type { SubmissionRecord } from "@/repositories/submission/types";
import type { SubmissionActionInput } from "@/services/ugc/contract/actions";

export async function requireSubmission(
  db: D1Database,
  input: Pick<SubmissionActionInput, "submissionId" | "kind">,
): Promise<SubmissionRecord> {
  const submission = await getSubmissionById(db, input.submissionId);
  if (!submission || submission.kind !== input.kind) {
    const label = input.kind === "comment" ? "Comment" : "Image";
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", `${label} submission was not found.`);
  }
  return submission;
}
