import type { TranslationMsg } from "@/queues/types/messages";
import { prewarmCommentTranslationWithNotification } from "@/services/upload/commentTranslationPrewarm";
import type { Bindings } from "@/types/app";

export async function processTranslationQueueBatch(
  env: Bindings,
  batch: MessageBatch<TranslationMsg>,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await prewarmCommentTranslationWithNotification(env, message.body);
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
