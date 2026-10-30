import type { SubmissionRecord, SubmissionStatus } from "@/repositories/submission/types";
import type { CommentTranslationPrewarmTarget } from "@/services/ugc/translation/types";
import type { AuthUser } from "@/types/app";

export type ModerationSubmission = Pick<
  SubmissionRecord,
  "id" | "kind" | "markerId" | "poiHash" | "poiType" | "snapshotId" | "userId" | "submitter"
>;

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
      submission: ModerationSubmission;
      actor: AuthUser;
      changed: boolean;
      flagCount: number;
      previousStatus: SubmissionStatus;
      nextStatus: SubmissionStatus;
    }
  | {
      type: "submission_moderation_result";
      submission: ModerationSubmission;
      previousStatus: SubmissionStatus;
      nextStatus: "active" | "pending_audit";
      source: SubmissionModerationSource;
    }
  | {
      type: "comment_translation_prewarm_completed";
      submission: ModerationSubmission;
      source: SubmissionModerationSource;
      targets: CommentTranslationPrewarmTarget[];
    };
