import type { AutoModerationMsg } from "@/queues/types/messages";
import { createAutoModerationReviewer } from "@/services/moderation/autoModeration";
import type { Bindings } from "@/types/app";

export async function runAutoModerationQueueBatch(
  bindings: Bindings,
  batch: MessageBatch<AutoModerationMsg>,
): Promise<void> {
  const review = createAutoModerationReviewer(bindings);
  for (const message of batch.messages) {
    try {
      await review(message.body);
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
