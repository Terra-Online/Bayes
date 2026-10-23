import type { Redis } from "@upstash/redis";

import { getRuntimeConfig, type RuntimeConfig } from "@/lib/config";
import {
  AI_ACTIVE_MODERATION_NOTE_PREFIX,
  AI_PENDING_AUDIT_MODERATION_NOTE_PREFIX,
  isCommentEditModerationNote,
} from "@/lib/moderation";
import { prewarmPublicUgcAsset } from "@/lib/publicUgcAssets";
import { createRedisClient } from "@/lib/redis";
import { invalidateUploadCaches } from "@/publicRead/client/invalidate";
import {
  getSubmissionById,
  transitionSubmissionStatusWithNotifications,
} from "@/repositories/submission/statusSubmission";
import type { SubmissionRecord } from "@/repositories/submission/types";
import { applyUserPointsDelta } from "@/repositories/users";
import { getModerationPointsDeltaWithDailyBackoff } from "@/services/karma/moderationPoints";
import { publishNotificationsCreated } from "@/services/notify/live";
import type { Bindings } from "@/types/app";

import type { OemModerationQueueMessage } from "./messages";
import { notifySubmissionModerationResult } from "./notifications";
import { requestOpenAiModeration, type OpenAiModerationResult } from "./openAiModeration";
import { ensureModerationBackfill, enqueueApprovedCommentTransPrewarm } from "./queue";

const SELECTED_MODERATION_MAX_RUNTIME_MS = 25_000;

export interface AutomaticModerationRunInput {
  submissionIds?: string[];
  limit?: number;
}

export interface AutomaticModerationStats {
  processed: number;
  active: number;
  pendingAudit: number;
  // Retained in existing responses; automatic moderation currently never archives submissions.
  stale: number;
}

export type AutomaticModerationRunResult =
  | (AutomaticModerationStats & { mode: "selected"; requested: number })
  | (AutomaticModerationStats & { mode: "queue"; requested: number; enqueued: number });

interface AutomaticModerationRuntime {
  bindings: Bindings;
  config: RuntimeConfig;
  redis: Redis;
}

interface AutomaticModerationDecision {
  nextStatus: "active" | "pending_audit";
  moderationNote: string;
  aiReviewed: boolean;
}

function createAutomaticModerationRuntime(bindings: Bindings): AutomaticModerationRuntime {
  const config = getRuntimeConfig(bindings);
  const redis = createRedisClient(bindings);
  return { bindings, config, redis };
}

function createAutomaticModerationStats(): AutomaticModerationStats {
  return { processed: 0, active: 0, pendingAudit: 0, stale: 0 };
}

function recordAutomaticModerationStatus(
  stats: AutomaticModerationStats,
  status: "active" | "pending_audit",
): void {
  stats.processed += 1;
  if (status === "active") {
    stats.active += 1;
  } else {
    stats.pendingAudit += 1;
  }
}

export async function runAutomaticModerationRequest(
  bindings: Bindings,
  input: AutomaticModerationRunInput,
): Promise<AutomaticModerationRunResult> {
  const runtime = createAutomaticModerationRuntime(bindings);
  const stats = createAutomaticModerationStats();
  if (input.submissionIds && input.submissionIds.length > 0) {
    const startedAt = Date.now();
    const ids = [...new Set(input.submissionIds.map((id) => id.trim()).filter(Boolean))];
    for (const submissionId of ids) {
      // Match the existing budget: finish an in-flight review before checking the next one.
      if (Date.now() - startedAt >= SELECTED_MODERATION_MAX_RUNTIME_MS) {
        break;
      }
      const status = await moderateSubmission(runtime, submissionId);
      if (status) {
        recordAutomaticModerationStatus(stats, status);
      }
    }
    return { mode: "selected", requested: input.submissionIds.length, ...stats };
  }

  const limit = input.limit ?? 5;
  const enqueued = await ensureModerationBackfill(bindings, limit);
  return { mode: "queue", requested: limit, enqueued, ...stats };
}

export async function runAutomaticModerationQueueBatch(
  bindings: Bindings,
  batch: MessageBatch<OemModerationQueueMessage>,
): Promise<AutomaticModerationStats> {
  const runtime = createAutomaticModerationRuntime(bindings);
  const stats = createAutomaticModerationStats();
  for (const message of batch.messages) {
    try {
      const status = await moderateSubmission(
        runtime,
        message.body.submissionId,
        message.body.snapshotId,
      );
      if (status) {
        recordAutomaticModerationStatus(stats, status);
      }
      message.ack();
    } catch (error) {
      console.warn("OEM_MODERATION_Q message failed", {
        type: message.body?.type,
        error: error instanceof Error ? error.message : String(error),
      });
      message.retry();
    }
  }
  return stats;
}

async function moderateSubmission(
  runtime: AutomaticModerationRuntime,
  submissionId: string,
  expectedSnapshotId?: string,
): Promise<"active" | "pending_audit" | null> {
  const { bindings, config } = runtime;
  const submission = await getSubmissionById(bindings.DB, submissionId);
  if (
    !submission ||
    submission.status !== "pending_openai" ||
    (expectedSnapshotId && submission.snapshotId !== expectedSnapshotId)
  ) {
    return null;
  }

  if (config.skipAiModeration) {
    return applyAutomaticModerationDecision(runtime, submission, {
      nextStatus: "pending_audit",
      aiReviewed: false,
      moderationNote: "AI moderation skipped; waiting for manual audit.",
    });
  }

  if (!bindings.OPENAI_API_KEY) {
    return applyAutomaticModerationDecision(runtime, submission, {
      nextStatus: config.localUploadAutoApprove ? "active" : "pending_audit",
      aiReviewed: false,
      moderationNote: config.localUploadAutoApprove
        ? "Local upload debug auto-approved (OPENAI_API_KEY missing)."
        : "OpenAI moderation skipped in local mode; waiting for manual audit.",
    });
  }

  let approved: boolean;
  let categorySummary: string;
  try {
    const imageUrl =
      submission.kind === "image" && submission.filePath
        ? await resolveModerationImageUrl(bindings.UGC_BUCKET, {
            filePath: submission.filePath,
            mimeType: submission.mimeType,
            fallbackUrl: `${config.ugcAssetBaseUrl.replace(/\/$/, "")}/${submission.filePath}`,
          })
        : undefined;
    const result = await requestOpenAiModeration(bindings.OPENAI_API_KEY, {
      text: submission.content ?? "",
      imageUrl,
      clientRequestId: `moderation:${submissionId}:${submission.snapshotId}`,
    });
    approved = result.outcome === "classified" && !result.flagged;
    categorySummary = describeModerationResult(result);
  } catch (error) {
    approved = false;
    categorySummary = `OpenAI moderation failed (${formatModerationError(error)}), sent to manual audit.`;
  }

  return applyAutomaticModerationDecision(runtime, submission, {
    nextStatus: approved ? "active" : "pending_audit",
    aiReviewed: true,
    moderationNote: approved
      ? `${AI_ACTIVE_MODERATION_NOTE_PREFIX} ${categorySummary}`
      : `${AI_PENDING_AUDIT_MODERATION_NOTE_PREFIX} ${categorySummary}`,
  });
}

function describeModerationResult(result: OpenAiModerationResult): string {
  switch (result.outcome) {
    case "classified":
      return result.categorySummary;
    case "empty_input":
      return "empty moderation input; sent to manual audit.";
    case "missing_decision":
      return "OpenAI moderation returned no explicit decision; sent to manual audit.";
    case "http_error":
      return `OpenAI moderation unavailable (${result.status}, request_id=${result.requestId}${result.detail ? `, ${result.detail}` : ""}), sent to manual audit.`;
  }
}

async function applyAutomaticModerationDecision(
  runtime: AutomaticModerationRuntime,
  submission: SubmissionRecord,
  decision: AutomaticModerationDecision,
): Promise<"active" | "pending_audit" | null> {
  const { bindings, config, redis } = runtime;
  const { nextStatus } = decision;
  const transition = await transitionSubmissionStatusWithNotifications(bindings.DB, {
    submission,
    status: nextStatus,
    moderationNote: decision.moderationNote,
    source: "auto_moderation",
    aiReviewed: decision.aiReviewed,
  });
  if (!transition.updated) {
    return null;
  }
  if (transition.notifications.length > 0) {
    await publishNotificationsCreated(bindings, transition.notifications).catch((error) => {
      console.warn("submission notification fanout failed", {
        submissionId: submission.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  await notifySubmissionModerationResult(bindings, {
    submission,
    previousStatus: submission.status,
    nextStatus,
    source: "auto_moderation",
  }).catch((error) => {
    console.warn("submission moderation notification enqueue failed", {
      submissionId: submission.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  if (nextStatus !== "active") {
    return nextStatus;
  }

  // Keep automatic moderation's awaited task order and separate points write.
  if (submission.kind === "image") {
    await prewarmPublicUgcAsset(config.ugcAssetBaseUrl, submission.filePath);
    await invalidateUploadCaches({
      kv: bindings.OEM_KV,
      kind: "image",
      markerId: submission.markerId,
    });
  } else {
    await invalidateUploadCaches({
      kv: bindings.OEM_KV,
      kind: "comment",
      markerId: submission.markerId,
    });
    await enqueueApprovedCommentTransPrewarm(bindings, submission.id, "auto_moderation");
  }

  const isPreviouslyApprovedEdit =
    isCommentEditModerationNote(submission.moderationNote) &&
    submission.editOriginalStatus !== "pending_openai" &&
    submission.editOriginalStatus !== "pending_audit";
  const pointsDelta = isPreviouslyApprovedEdit
    ? 0
    : await getModerationPointsDeltaWithDailyBackoff(redis, {
        userId: submission.userId,
        kind: submission.kind,
        status: nextStatus,
        role: submission.submitter?.role,
        surgeModeEnabled: config.surgeModeEnabled,
        surgeBackoffMultiplier: config.surgeBackoffMultiplier,
      });
  await applyUserPointsDelta(bindings.DB, submission.userId, pointsDelta);
  return nextStatus;
}

async function resolveModerationImageUrl(
  bucket: R2Bucket,
  payload: { filePath: string; mimeType: string | null; fallbackUrl: string },
): Promise<string> {
  const object = await bucket.get(payload.filePath);
  if (!object) {
    return payload.fallbackUrl;
  }

  const mimeType =
    object.httpMetadata?.contentType ?? payload.mimeType ?? "application/octet-stream";
  const body = await object.arrayBuffer();
  return `data:${mimeType};base64,${arrayBufferToBase64(body)}`;
}

function arrayBufferToBase64(body: ArrayBuffer): string {
  const bytes = new Uint8Array(body);
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function formatModerationError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "timeout" : error.message;
  }
  return "unknown error";
}
