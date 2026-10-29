import { nanoid } from "nanoid";

import { ApiError } from "@/lib/errors";
import { invalidateUploadCaches } from "@/publicRead/client/invalidate";
import { enqueueAutoModeration } from "@/queues/client/autoModeration";
import { appendCommentVersion } from "@/repositories/submission/appendCommentVersion";
import { markCommentModerationQueued } from "@/repositories/submission/createComment";
import { revertCommentEdit } from "@/repositories/submission/statusSubmission";
import type { SubmissionRecord } from "@/repositories/submission/types";
import type { UgcActionDependencies, UgcActionInput } from "@/services/ugc/contract/actions";
import { commentContentSchema } from "@/services/ugc/contract/commentContent";

interface EditCommentInput extends UgcActionInput {
  content: string;
  parentSnapshotId: string;
}

export async function editComment(dependencies: UgcActionDependencies, input: EditCommentInput) {
  const { bindings } = dependencies;
  const normalized = commentContentSchema.safeParse(input.content);
  if (!normalized.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid comment content.");
  }
  const result = await appendCommentVersion(bindings.DB, {
    submissionId: input.submissionId,
    parentSnapshotId: input.parentSnapshotId,
    actorId: input.actor.uid,
    snapshotId: nanoid(12),
    content: normalized.data,
  });
  if (result.outcome === "not_found") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Comment not found.");
  }
  if (result.outcome === "unauthorized") {
    throw new ApiError(
      403,
      "COMMENT_EDIT_OWNER_ONLY",
      "Only the author or an admin can edit a comment.",
    );
  }
  if (result.outcome === "conflict") {
    throw new ApiError(
      409,
      "COMMENT_EDIT_CONFLICT",
      "Comment changed or cannot be edited in its current status.",
    );
  }
  const { submission } = result;
  if (result.outcome === "appended") {
    // Preserve invalidation on queue failure; the committed version remains pending for backfill.
    dependencies.defer(
      invalidateUploadCaches({
        kv: bindings.OEM_KV,
        kind: "comment",
        markerId: submission.markerId,
      }),
    );
    const queuedAt = new Date().toISOString();
    await bindings.OEM_MODERATION_Q.send({
      type: "moderation",
      submissionId: submission.id,
      snapshotId: submission.snapshotId,
      source: "upload",
      queuedAt,
    });
    await markCommentModerationQueued(bindings.DB, {
      submissionId: submission.id,
      snapshotId: submission.snapshotId,
      queuedAt,
    }).catch((error) =>
      console.warn("moderation queued marker update failed", {
        submissionId: submission.id,
        error,
      }),
    );
  }
  return { submission };
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
