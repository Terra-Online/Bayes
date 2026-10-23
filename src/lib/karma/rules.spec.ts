import { describe, expect, it, vi } from "vitest";

import { calculateKarmaEvaluationScore } from "./rules";

// Fix the policy inputs so this checks scoring behavior independently of deployment tuning.
vi.mock("./karmaConfig.json", () => ({
  default: {
    evaluation: {
      activity: { maxPassivePoints: 0, medianDays: 1 },
      decay: { inactiveAfterDays: 30, penaltyAtMedianDays: 0, medianDays: 1 },
      quality: {
        imageApprovalBaseline: 0.5,
        imageApprovalWeight: 100,
        imageVolumeMedian: 10,
        minReviewedImages: 4,
      },
    },
  },
}));

describe("review quality in karma scoring", () => {
  it.each([
    { scenario: "no reviewed images", approvedImages: 0, rejectedImages: 0 },
    { scenario: "too few rejections", approvedImages: 0, rejectedImages: 3 },
    { scenario: "approval rate at the quality baseline", approvedImages: 5, rejectedImages: 5 },
  ])("preserves earned points with $scenario", ({ approvedImages, rejectedImages }) => {
    const now = new Date("2026-10-23T00:00:00Z");
    const input = { points: 100, createdAt: now.toISOString(), lastActive: now.toISOString() };
    expect(calculateKarmaEvaluationScore({ ...input, approvedImages, rejectedImages }, now)).toBe(
      100,
    );
  });

  it("rewards a reliable approval history and penalizes a reliable rejection history", () => {
    const now = new Date("2026-10-23T00:00:00Z");
    const input = { points: 100, createdAt: now.toISOString(), lastActive: now.toISOString() };
    // These histories clear the minimum review count, so quality can affect earned points.
    expect(
      calculateKarmaEvaluationScore({ ...input, approvedImages: 10, rejectedImages: 0 }, now),
    ).toBeGreaterThan(100);
    expect(
      calculateKarmaEvaluationScore({ ...input, approvedImages: 0, rejectedImages: 10 }, now),
    ).toBeLessThan(100);
  });
});
