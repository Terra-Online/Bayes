import type {
  ContributionReviewEvidence,
  ContributionReviewProjection,
  ReviewKey,
  ReviewStep,
} from "./contract/contributions";

export function projectContributionReview(
  evidence: ContributionReviewEvidence,
): ContributionReviewProjection {
  const path: ReviewStep[] = [{ key: "uploaded", at: evidence.snapshotCreatedAt }];
  const add = (key: ReviewKey, at: string | null) => {
    const last = path.at(-1);
    if (last?.key === key) {
      last.at = at ?? last.at;
    } else {
      path.push({ key, at });
    }
  };
  for (const event of evidence.events) {
    add(event.source === "ai" ? "ai" : "manual", event.at);
    if (event.to === "pending_audit") {
      add("manual", event.at);
    }
    if (event.to === "approved") {
      add("public", event.at);
    }
    if (event.to === "rejected") {
      add("archived", event.at);
    }
  }
  // Current facts can identify a stage, but never supply a missing decision time.
  // Imported snapshots deliberately have no reconstructed review history.
  const current = (
    {
      pending_openai: "ai",
      pending_audit: "manual",
      approved: "public",
      rejected: "archived",
      unknown: "archived",
    } as const
  )[evidence.reviewStatus];
  add(current, null);
  if (evidence.authorDeletedAt || evidence.adminDeletedAt) {
    add("archived", evidence.authorDeletedAt ?? evidence.adminDeletedAt);
  }
  const times: Record<ReviewKey, string | null> = {
    uploaded: null,
    ai: null,
    manual: null,
    public: null,
    archived: null,
  };
  for (const step of path) {
    times[step.key] = step.at;
  }
  let visibility: ContributionReviewProjection["visibility"] = "private";
  if (evidence.status === "stale") {
    visibility = "unavailable";
  } else if (evidence.status === "active" || evidence.status === "flagged") {
    visibility = "public";
  }
  return {
    visibility,
    review: {
      events: evidence.events,
      manual: path.some((step) => step.key === "manual"),
      published: path.some((step) => step.key === "public"),
      times,
      path,
    },
  };
}
