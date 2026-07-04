import type { AuthUser } from "../../types/app";
import type { SubmissionRecord, SubmissionStatus } from "../../repositories/submission/types";

export type ModerationQueueSource =
  | "upload"
  | "manual"
  | "scheduled_backfill";

export type TranslationPrewarmSource =
  | "auto_moderation"
  | "manual_moderation";

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
      type: "remove_request_created" | "remove_request_cancelled";
      submission: SubmissionRecord;
      actor: AuthUser;
      previousStatus: SubmissionStatus;
      nextStatus: SubmissionStatus;
      flagCount?: number;
      source: "remove_request" | "recall";
    };

export interface PendingOpenAICompletionStats {
  processed: number;
  active: number;
  pendingAudit: number;
  stale: number;
}

export type OemModQueueMessage =
  | {
      type: "moderation";
      submissionId: string;
      source: ModerationQueueSource;
      queuedAt: string;
    }
  | {
      type: "discord_notification";
      event: ModerationNotificationEvent;
      queuedAt: string;
    }
  | {
      type: "comment_translation_prewarm";
      submissionId: string;
      source: TranslationPrewarmSource;
      queuedAt: string;
    };
