import { nanoid } from "nanoid";

import { ApiError } from "@/lib/errors";
import {
  COMMENT_ADMIN_EDIT_MODERATION_NOTE_PREFIX,
  COMMENT_EDIT_MODERATION_NOTE_PREFIX,
} from "@/lib/moderation";
import { invalidateUploadCaches } from "@/publicRead/client/invalidate";
import { enqueueAutoModeration } from "@/queues/client/autoModeration";
import { clearSubmissionFlags } from "@/repositories/submission/flagSubmission";
import {
  revertCommentEdit,
  updateCommentContentForModeration,
} from "@/repositories/submission/statusSubmission";
import type { SubmissionRecord } from "@/repositories/submission/types";
import type { UgcActionDependencies, UgcActionInput } from "@/services/ugc/contract/actions";
import { requireSubmission } from "@/services/ugc/read/submissions";

interface EditCommentInput extends UgcActionInput {
  content: string;
}

function commentSummary(comment: SubmissionRecord) {
  return {
    id: comment.id,
    markerId: comment.markerId,
    parentId: comment.parentId,
    depth: comment.commentDepth,
    status: comment.status,
    snapshotId: comment.snapshotId,
  };
}

export async function editComment(dependencies: UgcActionDependencies, input: EditCommentInput) {
  const { bindings } = dependencies;
  const comment = await requireSubmission(bindings.DB, {
    submissionId: input.submissionId,
    kind: "comment",
  });
  const isAuthor = comment.userId === input.actor.uid;
  const isAdmin = input.actor.role === "a" || input.actor.role === "r";
  if (!isAuthor && !isAdmin) {
    throw new ApiError(
      403,
      "COMMENT_EDIT_OWNER_ONLY",
      "Only the author or an admin can edit a comment.",
    );
  }
  if (
    !["pending_openai", "pending_audit", "active", "flagged", "remove_request"].includes(
      comment.status,
    )
  ) {
    throw new ApiError(
      409,
      "INVALID_SUBMISSION_STATUS",
      "Comment cannot be edited in its current status.",
      { status: comment.status },
    );
  }

  if (comment.content === input.content) {
    return { submission: commentSummary(comment) };
  }

  const snapshotId = nanoid(12);
  const updated = await updateCommentContentForModeration(bindings.DB, {
    id: input.submissionId,
    content: input.content,
    expectedSnapshotId: comment.snapshotId,
    snapshotId,
    moderationNote: `${
      isAuthor ? COMMENT_EDIT_MODERATION_NOTE_PREFIX : COMMENT_ADMIN_EDIT_MODERATION_NOTE_PREFIX
    } awaiting moderation.`,
  });
  if (!updated) {
    throw new ApiError(
      409,
      "COMMENT_EDIT_CONFLICT",
      "Comment changed while the edit was being submitted.",
    );
  }
  await clearSubmissionFlags(bindings.DB, input.submissionId);
  // Schedule invalidation before awaiting the queue, including when sending fails.
  dependencies.defer(
    invalidateUploadCaches({ kv: bindings.OEM_KV, kind: "comment", markerId: comment.markerId }),
  );
  await enqueueAutoModeration(bindings, input.submissionId, snapshotId);

  return {
    submission: {
      ...commentSummary(comment),
      status: "pending_openai" as const,
      snapshotId,
    },
  };
}

export async function undoCommentEdit(
  dependencies: UgcActionDependencies,
  comment: SubmissionRecord,
) {
  const { bindings } = dependencies;
  // Preserve the existing restore rule: old flags/removal requests are not revived.
  const originalStatus = comment.editOriginalStatus;
  const status =
    originalStatus === "pending_openai" || originalStatus === "pending_audit"
      ? originalStatus
      : "active";
  const reverted = await revertCommentEdit(bindings.DB, {
    id: comment.id,
    expectedSnapshotId: comment.snapshotId,
    status,
    moderationNote: "Comment edit reverted by author.",
  });
  if (!reverted) {
    throw new ApiError(
      409,
      "COMMENT_EDIT_CONFLICT",
      "Comment changed while the edit was being reverted.",
    );
  }
  dependencies.defer(
    invalidateUploadCaches({ kv: bindings.OEM_KV, kind: "comment", markerId: comment.markerId }),
  );
  if (status === "pending_openai" && comment.editOriginalSnapshotId) {
    await enqueueAutoModeration(bindings, comment.id, comment.editOriginalSnapshotId);
  }
  return { status, editReverted: true as const, content: comment.editOriginalContent };
}
