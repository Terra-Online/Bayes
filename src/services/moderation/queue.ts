import { getRuntimeConfig } from "../../lib/config";
import { createRedisClient } from "../../lib/redis";
import { getPendingOpenAISubmissions } from "../../repositories/submission/createSubmission";
import { getSubmissionById, markSubmissionModerationQueued } from "../../repositories/submission/statusSubmission";
import type { Bindings } from "../../types/app";
import { prewarmApprovedCommentTrans } from "../upload/commentTranslation";
import { publishNotificationsCreated } from "../notify/live";
import {
  createEmptyPendingOpenAICompletionStats,
  notifyCommentTransPrewarmDone,
  notifySubmissionModerationResult,
  recordPendingOpenAICompletionStatus
} from "./notifications";
import { moderateSubmissionById } from "./core";
import type {
  OemModerationQueueMessage,
  OemTranslationQueueMessage,
  PendingOpenAICompletionStats
} from "./messages";

const MODERATION_BACKFILL_STALE_MS = 5 * 60 * 1000;

type ModerationOptions = Parameters<typeof moderateSubmissionById>[2];

function createModerationOptions(env: Bindings): ModerationOptions {
  const config = getRuntimeConfig(env);
  const redis = createRedisClient(env);
  return {
    openAiApiKey: env.OPENAI_API_KEY,
    assetBaseUrl: config.ugcAssetBaseUrl,
    ugcBucket: env.UGC_BUCKET,
    ugcKv: env.OEM_KV,
    redis,
    surgeModeEnabled: config.surgeModeEnabled,
    surgeBackoffMultiplier: config.surgeBackoffMultiplier,
    skipAiModeration: config.skipAiModeration,
    localAutoApprove: config.localUploadAutoApprove,
    enqueueApprovedCommentTransPrewarm: (submissionId) =>
      enqueueApprovedCommentTransPrewarm(env, submissionId, "auto_moderation"),
    enqueueSubmissionModerationNotice: (submission, previousStatus, nextStatus) =>
      notifySubmissionModerationResult(env, {
        submission,
        previousStatus,
        nextStatus,
        source: "auto_moderation"
      }),
    publishNotifications: (notifications) => publishNotificationsCreated(env, notifications)
  };
}

export async function enqueueModeration(
  env: Bindings,
  submissionId: string,
  snapshotId: string
): Promise<void> {
  const queuedAt = new Date().toISOString();
  await env.OEM_MODERATION_Q.send({
    type: "moderation",
    submissionId,
    snapshotId,
    source: "upload",
    queuedAt
  });
  await markSubmissionModerationQueued(env.DB, {
    id: submissionId,
    snapshotId,
    queuedAt
  }).catch((error) => {
    console.warn("moderation queued marker update failed", {
      submissionId,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

export async function enqueueApprovedCommentTransPrewarm(
  env: Bindings,
  submissionId: string,
  source: "auto_moderation" | "manual_moderation"
): Promise<void> {
  if (!getRuntimeConfig(env).commentTranslationPrewarmEnabled) {
    return;
  }

  await env.OEM_TRANSLATION_Q.send({
    type: "comment_translation_prewarm",
    submissionId,
    source,
    queuedAt: new Date().toISOString()
  });
}

export async function ensureModerationBackfill(
  env: Bindings,
  targetQueueSize = 20
): Promise<number> {
  const queuedBefore = new Date(Date.now() - MODERATION_BACKFILL_STALE_MS).toISOString();
  const pending = await getPendingOpenAISubmissions(env.DB, targetQueueSize, queuedBefore);
  let enqueued = 0;

  for (const item of pending) {
    const queuedAt = new Date().toISOString();
    await env.OEM_MODERATION_Q.send({
      type: "moderation",
      submissionId: item.id,
      snapshotId: item.snapshotId,
      source: "scheduled_backfill",
      queuedAt
    });
    await markSubmissionModerationQueued(env.DB, {
      id: item.id,
      snapshotId: item.snapshotId,
      queuedAt
    }).catch((error) => {
      console.warn("moderation backfill marker update failed", {
        submissionId: item.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    enqueued += 1;
  }

  return enqueued;
}

export async function processModerationQueueBatch(
  env: Bindings,
  batch: MessageBatch<OemModerationQueueMessage>
): Promise<PendingOpenAICompletionStats> {
  const options = createModerationOptions(env);
  const stats = createEmptyPendingOpenAICompletionStats();

  for (const message of batch.messages) {
    try {
      await processModerationQueueMessage(env, message.body, options, stats);
      message.ack();
    } catch (error) {
      console.warn("OEM_MODERATION_Q message failed", {
        type: message.body?.type,
        error: error instanceof Error ? error.message : String(error)
      });
      message.retry();
    }
  }

  return stats;
}

async function processModerationQueueMessage(
  env: Bindings,
  message: OemModerationQueueMessage,
  options: ModerationOptions,
  stats: PendingOpenAICompletionStats
): Promise<void> {
  const status = await moderateSubmissionById(
    env.DB,
    message.submissionId,
    options,
    message.snapshotId
  );
  if (status) {
    recordPendingOpenAICompletionStatus(stats, status);
  }
}

export async function processTranslationQueueBatch(
  env: Bindings,
  batch: MessageBatch<OemTranslationQueueMessage>
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processTranslationQueueMessage(env, message.body);
      message.ack();
    } catch (error) {
      console.warn("OEM_TRANSLATION_Q message failed", {
        type: message.body?.type,
        error: error instanceof Error ? error.message : String(error)
      });
      message.retry();
    }
  }
}

async function processTranslationQueueMessage(
  env: Bindings,
  message: OemTranslationQueueMessage
): Promise<void> {
  if (!getRuntimeConfig(env).commentTranslationPrewarmEnabled) {
    return;
  }

  const result = await prewarmApprovedCommentTrans(env, message.submissionId).catch((error) => {
    console.warn("comment translation prewarm failed", {
      submissionId: message.submissionId,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  });
  if (result && !result.skipped) {
    const submission = await getSubmissionById(env.DB, message.submissionId);
    if (submission) {
      await notifyCommentTransPrewarmDone(env, {
        submission,
        source: message.source,
        targets: result.targets
      });
    }
  }
}
