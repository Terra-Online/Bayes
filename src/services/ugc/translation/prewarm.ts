import { getRuntimeConfig } from "@/lib/config";
import { getSubmissionById } from "@/repositories/submission/statusSubmission";
import type { SubmissionModerationSource } from "@/services/moderation/messages";
import { notifyCommentTransPrewarmDone } from "@/services/moderation/notifications";
import { isGoogleTranslateConfigured } from "@/services/translation/googleTranslation";
import type { Bindings } from "@/types/app";

import { translateVisibleComments } from "./comments";
import type { CommentTranslationPrewarmTarget } from "./types";

export async function prewarmCommentTranslationWithNotification(
  env: Bindings,
  input: { submissionId: string; source: SubmissionModerationSource },
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

const APPROVED_COMMENT_PREWARM_TARGET_LANGUAGES = [
  "zh-CN",
  "en-US",
  "ru-RU",
  "ja-JP",
  "ko-KR",
] as const;

async function prewarmApprovedCommentTrans(
  env: Bindings,
  commentId: string,
): Promise<{ ok: boolean; skipped?: string; targets: CommentTranslationPrewarmTarget[] }> {
  const id = commentId.trim();
  const targetLangs = [...APPROVED_COMMENT_PREWARM_TARGET_LANGUAGES];
  const runtimeConfig = getRuntimeConfig(env);
  if (!runtimeConfig.commentTranslationPrewarmEnabled) {
    return {
      ok: true,
      skipped: "COMMENT_TRANSLATION_PREWARM_DISABLED",
      targets: targetLangs.map((lang) => ({
        lang,
        status: "skipped",
        error: "COMMENT_TRANSLATION_PREWARM_DISABLED",
      })),
    };
  }

  if (!id) {
    return {
      ok: false,
      skipped: "COMMENT_ID_EMPTY",
      targets: targetLangs.map((lang) => ({
        lang,
        status: "failed",
        error: "COMMENT_ID_EMPTY",
      })),
    };
  }

  const config = runtimeConfig.googleTranslate;
  if (!isGoogleTranslateConfigured(config)) {
    return {
      ok: true,
      skipped: "GOOGLE_TRANSLATE_NOT_CONFIGURED",
      targets: targetLangs.map((lang) => ({
        lang,
        status: "skipped",
        error: "GOOGLE_TRANSLATE_NOT_CONFIGURED",
      })),
    };
  }

  const results = await Promise.allSettled(
    targetLangs.map((targetLang) =>
      translateVisibleComments(env, {
        commentIds: [id],
        sourceLanguage: "auto",
        targetLanguage: targetLang,
      }),
    ),
  );

  return {
    ok: true,
    targets: results.map((result, index) => {
      const lang = targetLangs[index] ?? "";
      if (result.status === "rejected") {
        return {
          lang,
          status: "failed",
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        };
      }

      const item = result.value.items[0];
      if (item?.translatedContent) {
        return {
          lang,
          status: "success",
          cached: item.cached,
        };
      }

      return {
        lang,
        status: "failed",
        error: item?.error ?? "TRANSLATION_EMPTY",
      };
    }),
  };
}
