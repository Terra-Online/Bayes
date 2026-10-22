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
  it("requires enough reviewed images before rewarding approval or penalizing rejection", () => {
    const now = new Date("2026-10-23T00:00:00Z");
    const input = { points: 100, createdAt: now.toISOString(), lastActive: now.toISOString() };
    const score = (approvedImages: number, rejectedImages: number) =>
      calculateKarmaEvaluationScore({ ...input, approvedImages, rejectedImages }, now);
    expect(score(0, 0)).toBe(100);
    expect(score(3, 0)).toBe(100);
    expect(score(0, 3)).toBe(100);
    expect(score(10, 0)).toBeGreaterThan(100);
    expect(score(5, 5)).toBe(100);
    expect(score(0, 10)).toBeLessThan(100);
  });
});
