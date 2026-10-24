import { ApiError } from "@/lib/errors";
import { RECALL_MODERATION_NOTE_PREFIX } from "@/lib/moderation";
import { invalidateUploadCaches } from "@/publicRead/client/invalidate";
import { transitionSubmissionStatusWithNotifications } from "@/repositories/submission/statusSubmission";
import type { SubmissionRecord } from "@/repositories/submission/types";
import { publishNotificationsCreated } from "@/services/notify/live";
import type { SubmissionActionInput, UgcActionDependencies } from "@/services/ugc/contract/actions";
import { requireSubmission } from "@/services/ugc/read/submissions";

import { undoCommentEdit } from "./edits";

export async function recallSubmission(
  dependencies: UgcActionDependencies,
  input: SubmissionActionInput,
) {
  const submission = await requireSubmission(dependencies.bindings.DB, input);
  if (submission.userId !== input.actor.uid) {
    throw new ApiError(
      403,
      "RECALL_OWNER_ONLY",
      input.kind === "comment"
        ? "Only the author can recall a comment."
        : "Only the uploader can recall an image.",
    );
  }
  // Legacy recall chooses from the same read used for authorization and withdrawal.
  // A comment edit backup takes precedence even if the current status is stale.
  if (submission.kind === "comment" && submission.editOriginalContent !== null) {
    return undoCommentEdit(dependencies, submission);
  }
  return withdrawSubmission(dependencies, submission);
}

async function withdrawSubmission(
  dependencies: UgcActionDependencies,
  submission: SubmissionRecord,
) {
  const isComment = submission.kind === "comment";
  const label = isComment ? "Comment" : "Image";
  if (submission.status === "stale") {
    return { status: "stale" as const };
  }
  if (
    !["pending_openai", "pending_audit", "active", "flagged", "remove_request"].includes(
      submission.status,
    )
  ) {
    throw new ApiError(
      409,
      "INVALID_STATUS_TRANSITION",
      `${label} cannot be recalled from its current status.`,
      { from: submission.status, to: "stale" },
    );
  }

  const { bindings } = dependencies;
  const transition = await transitionSubmissionStatusWithNotifications(bindings.DB, {
    submission,
    status: "stale",
    moderationNote: `${RECALL_MODERATION_NOTE_PREFIX} ${isComment ? "comment withdrawn by author" : "image withdrawn by uploader"}.`,
    source: "user_action",
  });
  if (!transition.updated) {
    throw new ApiError(409, "RECALL_CONFLICT", `${label} changed while it was being recalled.`);
  }
  if (transition.notifications.length > 0) {
    dependencies.defer(publishNotificationsCreated(bindings, transition.notifications));
  }
  dependencies.defer(
    invalidateUploadCaches({
      kv: bindings.OEM_KV,
      kind: submission.kind,
      markerId: submission.markerId,
    }),
  );
  return { status: "stale" as const };
}
