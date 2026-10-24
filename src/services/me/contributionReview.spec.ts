import { expect, it } from "vitest";

import { projectContributionReview } from "./contributionReview";

it("removes an interrupted manual stage without discarding completed AI review", () => {
  const result = projectContributionReview({
    status: "stale",
    createdAt: "2026-09-01",
    updatedAt: "2026-09-03",
    events: [
      {
        from: "pending_openai",
        to: "pending_audit",
        source: "auto_moderation",
        at: "2026-09-02",
        aiReviewed: true,
      },
      {
        from: "pending_audit",
        to: "stale",
        source: "user_action",
        at: "2026-09-03",
        aiReviewed: false,
      },
    ],
    legacy: {
      manualAt: null,
      publicAt: null,
      hasManualEvidence: false,
      hasPublicationEvidence: false,
      moderationNote: null,
    },
  });

  expect(result).toEqual({
    visibility: "unavailable",
    review: {
      manual: false,
      published: false,
      path: [
        { key: "uploaded", at: "2026-09-01" },
        { key: "ai", at: "2026-09-02" },
        { key: "archived", at: "2026-09-03" },
      ],
      times: {
        uploaded: "2026-09-01",
        ai: "2026-09-02",
        manual: null,
        public: null,
        archived: "2026-09-03",
      },
    },
  });
});
