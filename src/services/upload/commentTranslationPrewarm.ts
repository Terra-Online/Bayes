import { getRuntimeConfig } from "@/lib/config";
import { getSubmissionById } from "@/repositories/submission/statusSubmission";
import type { TransPrewarmSource } from "@/services/moderation/messages";
import { notifyCommentTransPrewarmDone } from "@/services/moderation/notifications";
import type { Bindings } from "@/types/app";

import { prewarmApprovedCommentTrans } from "./commentTranslation";

export async function prewarmCommentTranslationWithNotification(
  env: Bindings,
  input: { submissionId: string; source: TransPrewarmSource },
): Promise<void> {
  if (!getRuntimeConfig(env).commentTranslationPrewarmEnabled) {
    return;
  }

  const result = await prewarmApprovedCommentTrans(env, input.submissionId).catch((error) => {
    console.warn("comment translation prewarm failed", {
      submissionId: input.submissionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  if (result && !result.skipped) {
    const submission = await getSubmissionById(env.DB, input.submissionId);
    if (submission) {
      await notifyCommentTransPrewarmDone(env, {
        submission,
        source: input.source,
        targets: result.targets,
      });
    }
  }
}
