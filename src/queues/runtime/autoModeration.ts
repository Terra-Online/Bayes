import type { AutoModerationMsg } from "@/queues/types/messages";
import { createAutoModerationReviewer } from "@/services/moderation/autoModeration";
import type { Bindings } from "@/types/app";

// Only the consumer admits pre-cutover messages. Producers require a snapshot ID.
export type LegacyAutoModerationMsg = Omit<AutoModerationMsg, "snapshotId"> & {
  snapshotId?: string;
};

export async function runAutoModerationQueueBatch(
  bindings: Bindings,
  batch: MessageBatch<LegacyAutoModerationMsg>,
): Promise<void> {
  const review = createAutoModerationReviewer(bindings);
  for (const message of batch.messages) {
    try {
      const { snapshotId } = message.body;
      if (!snapshotId) {
        console.warn("skipping unversioned moderation message", {
          submissionId: message.body.submissionId,
        });
        message.ack();
        continue;
      }
      await review({ ...message.body, snapshotId });
      message.ack();
    } catch (error) {
      console.warn("OEM_MODERATION_Q message failed", {
        type: message.body?.type,
        error: error instanceof Error ? error.message : String(error),
      });
      message.retry();
    }
  }
}
