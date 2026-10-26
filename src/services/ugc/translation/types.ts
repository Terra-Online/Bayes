export type CommentTranslationPrewarmTargetStatus = "success" | "failed" | "skipped";

export interface CommentTranslationPrewarmTarget {
  lang: string;
  status: CommentTranslationPrewarmTargetStatus;
  cached?: boolean;
  error?: string;
}
