import { getRuntimeConfig } from "@/lib/config";
import { getPendingAutoModerationSubmissions } from "@/repositories/submission/createSubmission";
import {
  getSubmissionById,
  markSubmissionAutoModerationQueued,
} from "@/repositories/submission/statusSubmission";
import { prewarmApprovedCommentTrans } from "@/services/upload/commentTranslation";
import type { Bindings } from "@/types/app";

import type { OemTranslationQueueMessage } from "./messages";
import { notifyCommentTransPrewarmDone } from "./notifications";

const AUTO_MODERATION_BACKFILL_STALE_MS = 5 * 60 * 1000;

export async function enqueueAutoModeration(
  env: Bindings,
  submissionId: string,
  snapshotId: string,
): Promise<void> {
  const queuedAt = new Date().toISOString();
  await env.OEM_AUTO_MODERATION_Q.send({
    type: "moderation",
    submissionId,
    snapshotId,
    source: "upload",
    queuedAt,
  });
  await markSubmissionAutoModerationQueued(env.DB, {
    id: submissionId,
    snapshotId,
    queuedAt,
  }).catch((error) => {
    console.warn("moderation queued marker update failed", {
      submissionId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function enqueueApprovedCommentTransPrewarm(
  env: Bindings,
  submissionId: string,
  source: "auto_moderation" | "manual_moderation",
): Promise<void> {
  if (!getRuntimeConfig(env).commentTranslationPrewarmEnabled) {
    return;
  }

  await env.OEM_TRANSLATION_Q.send({
    type: "comment_translation_prewarm",
    submissionId,
    source,
    queuedAt: new Date().toISOString(),
  });
}

export async function ensureAutoModerationBackfill(
  env: Bindings,
  targetQueueSize = 20,
): Promise<number> {
  const queuedBefore = new Date(Date.now() - AUTO_MODERATION_BACKFILL_STALE_MS).toISOString();
  const pending = await getPendingAutoModerationSubmissions(env.DB, targetQueueSize, queuedBefore);
  let enqueued = 0;

  for (const item of pending) {
    const queuedAt = new Date().toISOString();
    await env.OEM_AUTO_MODERATION_Q.send({
      type: "moderation",
      submissionId: item.id,
      snapshotId: item.snapshotId,
      source: "scheduled_backfill",
      queuedAt,
    });
    await markSubmissionAutoModerationQueued(env.DB, {
      id: item.id,
      snapshotId: item.snapshotId,
      queuedAt,
    }).catch((error) => {
      console.warn("moderation backfill marker update failed", {
        submissionId: item.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    enqueued += 1;
  }

  return enqueued;
}

export async function processTranslationQueueBatch(
  env: Bindings,
  batch: MessageBatch<OemTranslationQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processTranslationQueueMessage(env, message.body);
      message.ack();
    } catch (error) {
      console.warn("OEM_TRANSLATION_Q message failed", {
        type: message.body?.type,
        error: error instanceof Error ? error.message : String(error),
      });
      message.retry();
    }
  }
}

async function processTranslationQueueMessage(
  env: Bindings,
  message: OemTranslationQueueMessage,
): Promise<void> {
  if (!getRuntimeConfig(env).commentTranslationPrewarmEnabled) {
    return;
  }

  const result = await prewarmApprovedCommentTrans(env, message.submissionId).catch((error) => {
    console.warn("comment translation prewarm failed", {
      submissionId: message.submissionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  if (result && !result.skipped) {
    const submission = await getSubmissionById(env.DB, message.submissionId);
    if (submission) {
      await notifyCommentTransPrewarmDone(env, {
        submission,
        source: message.source,
        targets: result.targets,
      });
    }
  }
}
