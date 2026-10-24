import type {
  QueueMsg,
  AutoModerationMsg,
  TranslationMsg,
  WebhookMsg,
} from "@/queues/types/messages";
import type { Bindings } from "@/types/app";

import { runAutoModerationQueueBatch } from "./autoModeration";
import { processTranslationQueueBatch } from "./commentTranslation";
import { processWebhookQueueBatch } from "./moderationWebhook";

export async function handleQueue(batch: MessageBatch<QueueMsg>, env: Bindings): Promise<void> {
  if (batch.queue === "oem-moderation") {
    await runAutoModerationQueueBatch(env, batch as MessageBatch<AutoModerationMsg>);
    return;
  }
  if (batch.queue === "oem-translation") {
    await processTranslationQueueBatch(env, batch as MessageBatch<TranslationMsg>);
    return;
  }
  if (batch.queue === "oem-webhook") {
    await processWebhookQueueBatch(env, batch as MessageBatch<WebhookMsg>);
    return;
  }

  console.warn("unknown queue batch received", {
    queue: batch.queue,
    messages: batch.messages.length,
  });
  batch.retryAll();
}
