import { ApiError } from "@/lib/errors";
import { invalidateUploadCaches } from "@/publicRead/client/invalidate";
import {
  countSubmissionUpvotes,
  createSubmissionUpvote,
  deleteSubmissionUpvote,
  getSubmissionScore,
  setSubmissionVote,
} from "@/repositories/submission/voteSubmission";
import { publishNotificationsCreated } from "@/services/notify/live";
import type { UgcActionDependencies, UgcActionInput } from "@/services/ugc/contract/actions";
import { requireSubmission } from "@/services/ugc/read/submissions";

interface VoteCommentInput extends UgcActionInput {
  value: 1 | -1;
}

export async function voteComment(dependencies: UgcActionDependencies, input: VoteCommentInput) {
  const { bindings } = dependencies;
  const submission = await requireSubmission(bindings.DB, {
    submissionId: input.submissionId,
    kind: "comment",
  });
  if (!["active", "flagged", "remove_request"].includes(submission.status)) {
    throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only visible comments can be voted.", {
      status: submission.status,
    });
  }

  const vote = await setSubmissionVote(bindings.DB, {
    submissionId: input.submissionId,
    actor: input.actor,
    value: input.value,
  });
  const score = await getSubmissionScore(bindings.DB, input.submissionId);
  dependencies.defer(
    invalidateUploadCaches({ kv: bindings.OEM_KV, kind: "comment", markerId: submission.markerId }),
  );
  if (vote.notifications.length > 0) {
    dependencies.defer(publishNotificationsCreated(bindings, vote.notifications));
  }

  return { vote: vote.currentVote, previousVote: vote.previousVote, score };
}

export async function upvoteImage(dependencies: UgcActionDependencies, input: UgcActionInput) {
  const { bindings } = dependencies;
  const submission = await requireSubmission(bindings.DB, {
    submissionId: input.submissionId,
    kind: "image",
  });
  if (!["active", "flagged", "remove_request"].includes(submission.status)) {
    throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only visible images can be upvoted.", {
      status: submission.status,
    });
  }

  const created = await createSubmissionUpvote(bindings.DB, {
    submissionId: input.submissionId,
    actor: input.actor,
  });
  const upvoteCount = await countSubmissionUpvotes(bindings.DB, input.submissionId);
  dependencies.defer(
    invalidateUploadCaches({ kv: bindings.OEM_KV, kind: "image", markerId: submission.markerId }),
  );
  if (created.notifications.length > 0) {
    dependencies.defer(publishNotificationsCreated(bindings, created.notifications));
  }

  return { created: created.created, upvoteCount };
}

export async function unvoteImage(dependencies: UgcActionDependencies, input: UgcActionInput) {
  const { bindings } = dependencies;
  const submission = await requireSubmission(bindings.DB, {
    submissionId: input.submissionId,
    kind: "image",
  });
  if (!["active", "flagged", "remove_request"].includes(submission.status)) {
    throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only visible images can be unvoted.", {
      status: submission.status,
    });
  }

  const deleted = await deleteSubmissionUpvote(bindings.DB, {
    submissionId: input.submissionId,
    userId: input.actor.uid,
  });
  const upvoteCount = await countSubmissionUpvotes(bindings.DB, input.submissionId);
  dependencies.defer(
    invalidateUploadCaches({ kv: bindings.OEM_KV, kind: "image", markerId: submission.markerId }),
  );

  return { deleted, upvoteCount };
}
