import type { SnapshotReviewStatus } from "@/repositories/submission/snapshotReads";
import type { SubmissionKind, SubmissionStatus } from "@/repositories/submission/types";

export type ReviewKey = "uploaded" | "ai" | "manual" | "public" | "archived";
export type ReviewStep = { key: ReviewKey; at: string | null };

export type ReviewEvent = {
  id: string;
  snapshotId: string;
  from: SnapshotReviewStatus;
  to: SnapshotReviewStatus;
  source: "ai" | "admin";
  adminUserId: string | null;
  note: string | null;
  at: string;
};

export type ContributionReviewEvidence = {
  snapshotId: string;
  revision: number;
  reviewStatus: SnapshotReviewStatus;
  status: SubmissionStatus;
  createdAt: string;
  snapshotCreatedAt: string;
  authorDeletedAt: string | null;
  adminDeletedAt: string | null;
  // Only genuine transitions for the selected frontier, in insertion order.
  events: readonly ReviewEvent[];
};

export type ContributionReview = {
  events: readonly ReviewEvent[];
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
  snapshotId: string;
  revision: number;
  reviewStatus: SnapshotReviewStatus;
  authorDeletedAt: string | null;
  adminDeletedAt: string | null;
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
