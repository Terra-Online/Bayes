import type { WebhookMsg } from "@/queues/types/messages";
import { sendModerationNotificationNow } from "@/services/moderation/notifications";
import type { Bindings } from "@/types/app";

export async function processWebhookQueueBatch(
  env: Bindings,
  batch: MessageBatch<WebhookMsg>,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await sendModerationNotificationNow(env, message.body.event);
      message.ack();
    } catch (error) {
      console.warn("OEM_WEBHOOK_Q message failed", {
        type: message.body?.type,
        eventType: message.body?.event?.type,
        error: error instanceof Error ? error.message : String(error),
      });
      message.retry();
    }
  }
}
