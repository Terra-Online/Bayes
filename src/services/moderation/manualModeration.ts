import { getRuntimeConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { prewarmPublicUgcAsset } from "@/lib/publicUgcAssets";
import { createRedisClient } from "@/lib/redis";
import { invalidateUploadCaches } from "@/publicRead/client/invalidate";
import { enqueueApprovedCommentTransPrewarm } from "@/queues/client/commentTranslation";
import {
  disableSubmission,
  clearSubmissionFlags,
} from "@/repositories/submission/managementActions";
import { listManagementSubmissions } from "@/repositories/submission/managementReads";
import { getReviewTarget, reviewSnapshot } from "@/repositories/submission/reviewSnapshot";
import { applyUserPointsDelta } from "@/repositories/users";
import { getModerationPointsDeltaWithDailyBackoff } from "@/services/karma/moderationPoints";
import type { ManagementAction } from "@/services/moderation/contract/actions";
import { hintUgcEvent } from "@/services/notify/hints";
import type { AuthUser, Bindings } from "@/types/app";

import { notifySubmissionModerationResult } from "./notifications";

export interface ManualModerationInput {
  actor: Pick<AuthUser, "uid">;
  submissionId: string;
  command: ManagementAction;
}
export interface ManualModerationResult {
  actorUserId: string;
  outcome: "committed" | "no_op";
}
export interface ManualModerationDependencies {
  bindings: Bindings;
  defer(task: Promise<unknown>): void;
}
async function conflict(db: D1Database, submissionId: string): Promise<never> {
  const current = await listManagementSubmissions(db, { submissionId });
  if (!current.items.length) {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission was not found.");
  }
  throw new ApiError(
    409,
    "MODERATION_CONFLICT",
    "The displayed version or review phase changed, or the action is no longer eligible.",
  );
}

export async function applyManualModeration(
  dependencies: ManualModerationDependencies,
  input: ManualModerationInput,
): Promise<ManualModerationResult> {
  const { bindings } = dependencies;
  const { command } = input;
  if (command.action === "disable" || command.action === "clear_flags") {
    const target = {
      submissionId: input.submissionId,
      adminUserId: input.actor.uid,
      note: command.note,
    };
    const result =
      command.action === "disable"
        ? await disableSubmission(bindings.DB, {
            ...target,
            snapshotId: command.snapshotId,
            expectedLifecycleVersion: command.expectedLifecycleVersion,
          })
        : await clearSubmissionFlags(bindings.DB, target);
    if (result.outcome === "conflict") {
      return conflict(bindings.DB, input.submissionId);
    }
    if (result.outcome === "committed" && command.action === "disable") {
      const current = result.target;
      dependencies.defer(
        invalidateUploadCaches({
          kv: bindings.OEM_KV,
          kind: current.kind,
          markerId: current.markerId,
        }),
      );
    }
    if (result.outcome === "committed" && command.action === "clear_flags") {
      dependencies.defer(
        invalidateUploadCaches({
          kv: bindings.OEM_KV,
          kind: result.target.kind,
          markerId: result.target.markerId,
        }),
      );
    }
    return { actorUserId: input.actor.uid, outcome: result.outcome };
  }
  const current = await getReviewTarget(bindings.DB, input.submissionId, command.snapshotId);
  if (!current) {
    return conflict(bindings.DB, input.submissionId);
  }
  const { decision, nextStatus } = (
    {
      approve: { decision: "approved", nextStatus: "active" },
      reject: { decision: "rejected", nextStatus: "stale" },
      send_to_manual: { decision: "pending_audit", nextStatus: "pending_audit" },
    } as const
  )[command.action];
  const transition = await reviewSnapshot(bindings.DB, {
    target: current,
    expectedReviewStatus: command.expectedReviewStatus,
    decision,
    note: command.note,
    source: "admin",
    adminUserId: input.actor.uid,
    auditId: crypto.randomUUID(),
  });
  if (transition.outcome === "ignored") {
    return conflict(bindings.DB, input.submissionId);
  }
  dependencies.defer(hintUgcEvent(bindings, transition.event));
  if (nextStatus === "active" || nextStatus === "pending_audit") {
    dependencies.defer(
      notifySubmissionModerationResult(bindings, {
        submission: current,
        previousStatus:
          command.expectedReviewStatus === "pending_openai" ? "pending_openai" : "pending_audit",
        nextStatus,
        source: "manual_moderation",
      }),
    );
  }
  const config = getRuntimeConfig(bindings);
  if (decision === "approved" && current.kind === "image") {
    dependencies.defer(prewarmPublicUgcAsset(config.ugcAssetBaseUrl, current.filePath));
  }
  dependencies.defer(
    invalidateUploadCaches({ kv: bindings.OEM_KV, kind: current.kind, markerId: current.markerId }),
  );
  if (decision === "approved" && current.kind === "comment") {
    dependencies.defer(
      enqueueApprovedCommentTransPrewarm(bindings, current.id, "manual_moderation"),
    );
  }
  // Points remain independent. A committed phase cannot be replayed after points fail.
  if (
    current.creationSource !== "admin" &&
    ((decision === "approved" && transition.firstApproval) ||
      (decision === "rejected" && !current.hasEarlierApproval))
  ) {
    await applyUserPointsDelta(
      bindings.DB,
      current.userId,
      await getModerationPointsDeltaWithDailyBackoff(createRedisClient(bindings), {
        userId: current.userId,
        kind: current.kind,
        status: nextStatus === "active" ? "active" : "stale",
        role: current.submitter?.role,
        surgeModeEnabled: config.surgeModeEnabled,
        surgeBackoffMultiplier: config.surgeBackoffMultiplier,
      }),
    );
  }
  return { actorUserId: input.actor.uid, outcome: "committed" };
}
