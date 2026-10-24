import { getRuntimeConfig } from "@/lib/config";
import type { SubmissionModerationSource } from "@/services/moderation/messages";
import type { Bindings } from "@/types/app";

export async function enqueueApprovedCommentTransPrewarm(
  env: Bindings,
  submissionId: string,
  source: SubmissionModerationSource,
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
