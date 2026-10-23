import type {
  ModerationNotificationEvent,
  TransPrewarmSource,
} from "@/services/moderation/messages";

// "manual" identifies an operator-triggered automatic review, not a manual review decision.
export type AutoModerationQueueSource = "upload" | "manual" | "scheduled_backfill";

export type AutoModerationMsg = {
  type: "moderation";
  submissionId: string;
  snapshotId?: string;
  source: AutoModerationQueueSource;
  queuedAt: string;
};

export type TranslationMsg = {
  type: "comment_translation_prewarm";
  submissionId: string;
  source: TransPrewarmSource;
  queuedAt: string;
};

export type WebhookMsg = {
  type: "discord_notification";
  event: ModerationNotificationEvent;
  queuedAt: string;
};

export type QueueMsg = AutoModerationMsg | TranslationMsg | WebhookMsg;
