import {
  getPendingAutomaticReviews,
  markAutomaticReviewQueued,
} from "@/repositories/submission/automaticReviewQueue";
import type { Bindings } from "@/types/app";

const AUTO_MODERATION_BACKFILL_STALE_MS = 5 * 60 * 1000;

export async function enqueueAutoModeration(
  env: Bindings,
  submissionId: string,
  snapshotId: string,
): Promise<void> {
  const queuedAt = new Date().toISOString();
  await env.OEM_MODERATION_Q.send({
    type: "moderation",
    submissionId,
    snapshotId,
    source: "upload",
    queuedAt,
  });
  await markAutomaticReviewQueued(env.DB, {
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

export async function ensureAutoModerationBackfill(
  env: Bindings,
  targetQueueSize = 20,
): Promise<number> {
  const queuedBefore = new Date(Date.now() - AUTO_MODERATION_BACKFILL_STALE_MS).toISOString();
  const pending = await getPendingAutomaticReviews(env.DB, targetQueueSize, queuedBefore);
  let enqueued = 0;

  for (const item of pending) {
    const queuedAt = new Date().toISOString();
    await env.OEM_MODERATION_Q.send({
      type: "moderation",
      submissionId: item.id,
      snapshotId: item.snapshotId,
      source: "scheduled_backfill",
      queuedAt,
    });
    await markAutomaticReviewQueued(env.DB, {
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
