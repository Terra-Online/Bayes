export type SnapshotReviewStatus =
  | "pending_openai"
  | "pending_audit"
  | "approved"
  | "rejected"
  | "unknown";
