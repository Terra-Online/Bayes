import type { SubmissionKind, SubmissionStatus } from "@/repositories/submission/types";

export type ReviewKey = "uploaded" | "ai" | "manual" | "public" | "archived";
export type ReviewStep = { key: ReviewKey; at: string | null };

export type ReviewEvent = {
  from: SubmissionStatus;
  to: SubmissionStatus;
  source: "auto_moderation" | "manual_moderation" | "user_action";
  at: string;
  aiReviewed: boolean;
};

export type LegacyReviewEvidence = {
  // Notification times are partial historical evidence, not necessarily decision times.
  manualAt: string | null;
  publicAt: string | null;
  hasManualEvidence: boolean;
  hasPublicationEvidence: boolean;
  moderationNote: string | null;
};

export type ContributionReviewEvidence = {
  status: SubmissionStatus;
  createdAt: string;
  updatedAt: string;
  // The repository supplies only current-snapshot events, ordered by event ID.
  events: readonly ReviewEvent[];
  legacy: LegacyReviewEvidence;
};

export type ContributionReview = {
  // Includes an ongoing manual stage; this does not imply a completed decision.
  manual: boolean;
  published: boolean;
  // Repeated stages use the last occurrence in path, including an unknown time.
  times: Record<ReviewKey, string | null>;
  path: ReviewStep[];
};

export type ContributionReviewProjection = {
  visibility: "public" | "private" | "unavailable";
  review: ContributionReview;
};

export type ContributionItem = ContributionReviewProjection & {
  id: string;
  kind: SubmissionKind;
  markerId: string;
  poiType: string;
  content: string | null;
  previewUrl: string | null;
  status: SubmissionStatus;
  createdAt: string;
};

export type ContributionCursor = { createdAt: string; id: string };

export type ContributionQuery = {
  uid: string;
  kind?: SubmissionKind;
  status?: SubmissionStatus;
  cursor?: ContributionCursor;
  limit: number;
};

export type ContributionPage = {
  items: ContributionItem[];
  nextCursor: string | null;
};
