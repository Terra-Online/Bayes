import { ApiError } from "@/lib/errors";
import { invalidateUploadCaches } from "@/publicRead/client/invalidate";
import { setImageUpvote, setSubmissionVote } from "@/repositories/submission/voteSubmission";
import { publishNotificationsCreated } from "@/services/notify/live";
import type { UgcActionDependencies, UgcActionInput } from "@/services/ugc/contract/actions";

interface VoteCommentInput extends UgcActionInput {
  value: 1 | -1;
}

export async function voteComment(dependencies: UgcActionDependencies, input: VoteCommentInput) {
  const { bindings } = dependencies;
  const vote = await setSubmissionVote(bindings.DB, {
    submissionId: input.submissionId,
    actor: input.actor,
    value: input.value,
  });
  if (vote.outcome === "missing") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Comment submission was not found.");
  }
  if (vote.outcome !== "voted") {
    throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only visible comments can be voted.");
  }
  dependencies.defer(
    invalidateUploadCaches({ kv: bindings.OEM_KV, kind: "comment", markerId: vote.markerId }),
  );
  if (vote.notifications.length > 0) {
    dependencies.defer(publishNotificationsCreated(bindings, vote.notifications));
  }

  return { vote: vote.currentVote, previousVote: vote.previousVote, score: vote.score };
}

async function setImageVote(
  dependencies: UgcActionDependencies,
  input: UgcActionInput,
  active: boolean,
) {
  const { bindings } = dependencies;
  const result = await setImageUpvote(bindings.DB, { ...input, active });
  if (result.outcome === "missing") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
  }
  if (result.outcome !== "committed") {
    throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only visible images can be voted.");
  }
  dependencies.defer(
    invalidateUploadCaches({ kv: bindings.OEM_KV, kind: "image", markerId: result.markerId }),
  );
  if (result.notifications.length > 0) {
    dependencies.defer(publishNotificationsCreated(bindings, result.notifications));
  }
  return result;
}

export async function upvoteImage(dependencies: UgcActionDependencies, input: UgcActionInput) {
  const result = await setImageVote(dependencies, input, true);
  return { created: result.changed, upvoteCount: result.upvoteCount };
}

export async function unvoteImage(dependencies: UgcActionDependencies, input: UgcActionInput) {
  const result = await setImageVote(dependencies, input, false);
  return { deleted: result.changed, upvoteCount: result.upvoteCount };
}
