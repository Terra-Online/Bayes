import type { SubmissionRecord, SubmissionStatus } from "@/repositories/submission/types";
import type { CommentTranslationPrewarmTarget } from "@/services/commentTranslation/types";
import type { AuthUser } from "@/types/app";

export type SubmissionModerationSource = "auto_moderation" | "manual_moderation";

export type ModerationNotificationEvent =
  | {
      type: "pending_openai_completed";
      mode: "queue" | "selected";
      requested: number;
      processed: number;
      active: number;
      pendingAudit: number;
      stale: number;
    }
  | {
      type: "flag_created" | "flag_removed";
      submission: SubmissionRecord;
      actor: AuthUser;
      changed: boolean;
      flagCount: number;
      previousStatus: SubmissionStatus;
      nextStatus: SubmissionStatus;
    }
  | {
      type: "submission_moderation_result";
      submission: SubmissionRecord;
      previousStatus: SubmissionStatus;
      nextStatus: "active" | "pending_audit";
      source: SubmissionModerationSource;
    }
  | {
      type: "remove_request_created" | "remove_request_cancelled";
      submission: SubmissionRecord;
      actor: AuthUser;
      previousStatus: SubmissionStatus;
      nextStatus: SubmissionStatus;
      flagCount?: number;
      source: "remove_request" | "recall";
    }
  | {
      type: "comment_translation_prewarm_completed";
      submission: SubmissionRecord;
      source: SubmissionModerationSource;
      targets: CommentTranslationPrewarmTarget[];
    };
