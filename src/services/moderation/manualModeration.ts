import { getRuntimeConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { isCommentEditModerationNote, RECALL_MODERATION_NOTE_PREFIX } from "@/lib/moderation";
import { prewarmPublicUgcAsset } from "@/lib/publicUgcAssets";
import { createRedisClient } from "@/lib/redis";
import { invalidateUploadCaches } from "@/publicRead/client/invalidate";
import { enqueueApprovedCommentTransPrewarm } from "@/queues/client/commentTranslation";
import {
  getSubmissionById,
  transitionSubmissionStatusWithNotifications,
} from "@/repositories/submission/statusSubmission";
import type { SubmissionStatus } from "@/repositories/submission/types";
import { applyUserPointsDelta } from "@/repositories/users";
import { getModerationPointsDeltaWithDailyBackoff } from "@/services/karma/moderationPoints";
import { publishNotificationsCreated } from "@/services/notify/live";
import type { Bindings } from "@/types/app";

import { notifySubmissionModerationResult } from "./notifications";

export interface ManualModerationInput {
  submissionId: string;
  nextStatus: SubmissionStatus;
  moderationNote?: string;
}

export interface ManualModerationDependencies {
  bindings: Bindings;
  defer(task: Promise<unknown>): void;
}

const STATUS_TRANSITIONS: Record<SubmissionStatus, SubmissionStatus[]> = {
  pending_openai: ["active", "pending_audit", "stale"],
  pending_audit: ["active", "stale"],
  active: ["stale"],
  flagged: ["active", "stale"],
  remove_request: ["active", "stale"],
  stale: ["active"],
};

function assertStatusTransition(from: SubmissionStatus, to: SubmissionStatus): void {
  if (from === to) {
    return;
  }

  if (!STATUS_TRANSITIONS[from].includes(to)) {
    throw new ApiError(
      409,
      "INVALID_STATUS_TRANSITION",
      `Cannot move submission from ${from} to ${to}.`,
      {
        from,
        to,
        allowed: STATUS_TRANSITIONS[from],
      },
    );
  }
}

function shouldApplyModerationPoints(
  currentStatus: SubmissionStatus,
  nextStatus: SubmissionStatus,
  moderationNote: string | null,
): boolean {
  if (currentStatus === nextStatus || (nextStatus !== "active" && nextStatus !== "stale")) {
    return false;
  }

  if (nextStatus === "stale" && moderationNote?.startsWith(RECALL_MODERATION_NOTE_PREFIX)) {
    return false;
  }

  return true;
}

// Status and points writes are awaited; follow-up tasks retain their background lifetime.
// Points are a separate write, so their failure does not roll back the status transition.
export async function applyManualModeration(
  dependencies: ManualModerationDependencies,
  input: ManualModerationInput,
): Promise<void> {
  const { bindings } = dependencies;
  const current = await getSubmissionById(bindings.DB, input.submissionId);
  if (!current) {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission was not found.");
  }
  assertStatusTransition(current.status, input.nextStatus);

  const transition = await transitionSubmissionStatusWithNotifications(bindings.DB, {
    submission: current,
    status: input.nextStatus,
    moderationNote: input.moderationNote,
    source: "manual_moderation",
    clearFlags: current.status === "flagged" && input.nextStatus === "active",
  });
  if (!transition.updated) {
    throw new ApiError(
      409,
      "MODERATION_CONFLICT",
      "Submission changed while it was being moderated.",
    );
  }
  if (transition.notifications.length > 0) {
    dependencies.defer(publishNotificationsCreated(bindings, transition.notifications));
  }
  if (
    current.status !== input.nextStatus &&
    (input.nextStatus === "active" || input.nextStatus === "pending_audit")
  ) {
    dependencies.defer(
      notifySubmissionModerationResult(bindings, {
        submission: current,
        previousStatus: current.status,
        nextStatus: input.nextStatus,
        source: "manual_moderation",
      }),
    );
  }
  if (current.status !== "active" && input.nextStatus === "active" && current.kind === "image") {
    const config = getRuntimeConfig(bindings);
    dependencies.defer(prewarmPublicUgcAsset(config.ugcAssetBaseUrl, current.filePath));
  }
  dependencies.defer(
    invalidateUploadCaches({ kv: bindings.OEM_KV, kind: current.kind, markerId: current.markerId }),
  );
  if (current.kind === "comment") {
    if (current.status !== "active" && input.nextStatus === "active") {
      dependencies.defer(
        enqueueApprovedCommentTransPrewarm(bindings, input.submissionId, "manual_moderation"),
      );
    }
  }
  // Existing note prefixes carry edit and recall semantics; preserve that compatibility.
  const effectiveModerationNote = input.moderationNote ?? current.moderationNote;
  const isPreviouslyApprovedEdit =
    isCommentEditModerationNote(current.moderationNote) &&
    current.editOriginalStatus !== "pending_openai" &&
    current.editOriginalStatus !== "pending_audit";
  if (
    !isPreviouslyApprovedEdit &&
    shouldApplyModerationPoints(current.status, input.nextStatus, effectiveModerationNote)
  ) {
    const reviewStatus = input.nextStatus === "active" ? "active" : "stale";
    const redis = createRedisClient(bindings);
    const config = getRuntimeConfig(bindings);
    await applyUserPointsDelta(
      bindings.DB,
      current.userId,
      await getModerationPointsDeltaWithDailyBackoff(redis, {
        userId: current.userId,
        kind: current.kind,
        status: reviewStatus,
        role: current.submitter?.role,
        surgeModeEnabled: config.surgeModeEnabled,
        surgeBackoffMultiplier: config.surgeBackoffMultiplier,
      }),
    );
  }
}
