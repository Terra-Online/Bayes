import { ApiError } from "@/lib/errors";
import { invalidateUploadCaches } from "@/publicRead/client/invalidate";
import { deleteByAuthor } from "@/repositories/submission/deleteByAuthor";
import type { SubmissionActionInput, UgcActionDependencies } from "@/services/ugc/contract/actions";

export async function deleteSubmissionByAuthor(
  dependencies: UgcActionDependencies,
  input: SubmissionActionInput,
) {
  const result = await deleteByAuthor(dependencies.bindings.DB, {
    submissionId: input.submissionId,
    kind: input.kind,
    authorId: input.actor.uid,
  });
  if (result.outcome === "not_found") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission not found.");
  }
  if (result.outcome === "unauthorized") {
    throw new ApiError(403, "DELETE_OWNER_ONLY", "Only the author can delete this submission.");
  }
  if (result.outcome === "deleted") {
    dependencies.defer(
      invalidateUploadCaches({
        kv: dependencies.bindings.OEM_KV,
        kind: input.kind,
        markerId: result.markerId,
      }),
    );
  }
  return { authorDeletedAt: result.authorDeletedAt };
}
