import karmaConfig from "./karma-config.json";

type KarmaLevel = {
  karma: number;
  minPoints: number;
};

type RateLimitBand = {
  minKarma: number;
  limit: number;
};

export interface KarmaEvaluationInput {
  points: number;
  createdAt: string;
  lastActive: string;
  approvedImages: number;
  rejectedImages: number;
}

function sortedLevels(): KarmaLevel[] {
  return [...karmaConfig.levels].sort((a, b) => a.minPoints - b.minPoints);
}

export function pointsToKarma(points: number): number {
  const normalizedPoints = Number.isFinite(points) ? Math.max(0, Math.floor(points)) : 0;
  let current = 0;

  for (const level of sortedLevels()) {
    if (normalizedPoints >= level.minPoints) {
      current = level.karma;
    }
  }

  return Math.min(5, Math.max(0, current));
}

export function getKarmaEvaluationIntervalSeconds(backoffMultiplier = 1): number {
  const normalizedBackoffMultiplier = Math.max(1, Math.floor(backoffMultiplier));
  return Math.max(3600, Math.floor(karmaConfig.evaluation.intervalSeconds / normalizedBackoffMultiplier));
}

export function getKarmaEvaluationBatchSize(): number {
  return Math.max(1, Math.min(5000, karmaConfig.evaluation.batchSize));
}

export function calculateKarmaEvaluationScore(input: KarmaEvaluationInput, now = new Date()): number {
  const activity = karmaConfig.evaluation.activity;
  const decay = karmaConfig.evaluation.decay;
  const quality = karmaConfig.evaluation.quality;
  const createdAt = parseSqlDate(input.createdAt, now);
  const lastActive = parseSqlDate(input.lastActive, createdAt);
  const usageSpanDays = Math.max(0, daysBetween(createdAt, lastActive));
  const inactiveDays = Math.max(0, daysBetween(lastActive, now));
  const inactiveOverdueDays = Math.max(0, inactiveDays - decay.inactiveAfterDays);
  const passiveActivityScore = asymptoticScore(
    usageSpanDays,
    activity.maxPassivePoints,
    activity.medianDays
  );
  const inactivityPenalty = decay.penaltyAtMedianDays * Math.sqrt(inactiveOverdueDays / Math.max(1, decay.medianDays));
  const imageQualityScore = calculateImageQualityScore({
    approvedImages: input.approvedImages,
    rejectedImages: input.rejectedImages,
    baseline: quality.imageApprovalBaseline,
    weight: quality.imageApprovalWeight,
    volumeMedian: quality.imageVolumeMedian,
    minReviewedImages: quality.minReviewedImages
  });

  return Math.max(
    0,
    Math.floor(input.points + passiveActivityScore + imageQualityScore - inactivityPenalty)
  );
}

function calculateImageQualityScore(payload: {
  approvedImages: number;
  rejectedImages: number;
  baseline: number;
  weight: number;
  volumeMedian: number;
  minReviewedImages: number;
}): number {
  const approvedImages = Math.max(0, Math.floor(payload.approvedImages));
  const rejectedImages = Math.max(0, Math.floor(payload.rejectedImages));
  const reviewedImages = approvedImages + rejectedImages;

  if (reviewedImages < payload.minReviewedImages) {
    return 0;
  }

  const approvalRate = approvedImages / reviewedImages;
  const volumeConfidence = reviewedImages / (reviewedImages + Math.max(1, payload.volumeMedian));
  return (approvalRate - payload.baseline) * payload.weight * volumeConfidence;
}

function asymptoticScore(value: number, maxScore: number, medianValue: number): number {
  const normalizedValue = Math.max(0, value);
  const normalizedMedian = Math.max(1, medianValue);
  return maxScore * (normalizedValue / (normalizedValue + normalizedMedian));
}

function parseSqlDate(raw: string, fallback: Date): Date {
  const normalized = raw.trim();
  if (!normalized) {
    return fallback;
  }

  const timestamp = Date.parse(normalized.includes("T") ? normalized : `${normalized.replace(" ", "T")}Z`);
  if (!Number.isFinite(timestamp)) {
    return fallback;
  }

  return new Date(timestamp);
}

function daysBetween(start: Date, end: Date): number {
  const deltaMs = end.getTime() - start.getTime();
  return deltaMs / (24 * 60 * 60 * 1000);
}

export function getApprovedImageDailyBackoffTtlSeconds(): number {
  return Math.max(3600, karmaConfig.scoreRules.moderation.approvedImageDailyBackoff.counterTtlSeconds);
}

export function getApprovedCommentDailyBackoffTtlSeconds(): number {
  return Math.max(3600, karmaConfig.scoreRules.moderation.approvedCommentDailyBackoff.counterTtlSeconds);
}

export function getModerationPointsDelta(
  kind: "image" | "comment",
  status: "active" | "stale",
  dailyApprovedCount = 1,
  minimumActivePoints = 0,
  backoffMultiplier = 1
): number {
  if (status === "active") {
    const normalizedBackoffMultiplier = Math.max(1, Math.floor(backoffMultiplier));
    if (kind === "comment") {
      const basePoints = karmaConfig.scoreRules.moderation.approvedComment;
      const halfRewardAtCount = Math.max(
        2,
        karmaConfig.scoreRules.moderation.approvedCommentDailyBackoff.halfRewardAtCount * normalizedBackoffMultiplier
      );
      return Math.max(minimumActivePoints, calculateDailyBackoffPoints(basePoints, halfRewardAtCount, dailyApprovedCount));
    }

    const basePoints = karmaConfig.scoreRules.moderation.approvedImage;
    const halfRewardAtCount = Math.max(
      2,
      karmaConfig.scoreRules.moderation.approvedImageDailyBackoff.halfRewardAtCount * normalizedBackoffMultiplier
    );
    return Math.max(minimumActivePoints, calculateDailyBackoffPoints(basePoints, halfRewardAtCount, dailyApprovedCount));
  }

  return Math.floor(karmaConfig.scoreRules.moderation.rejectedSubmission);
}

function calculateDailyBackoffPoints(basePoints: number, halfRewardAtCount: number, dailyApprovedCount: number): number {
  const backoffBase = halfRewardAtCount - 1;
  const count = Math.max(1, Math.floor(dailyApprovedCount));
  return Math.floor(basePoints * (backoffBase / (backoffBase + count - 1)));
}

export function getUploadRateLimitForKarma(karma: number): number {
  const normalizedKarma = Number.isFinite(karma) ? Math.max(0, Math.floor(karma)) : 0;
  const bands = [...karmaConfig.uploadRateLimitPerMinute].sort(
    (a: RateLimitBand, b: RateLimitBand) => a.minKarma - b.minKarma
  );
  let limit = bands[0]?.limit ?? 4;

  for (const band of bands) {
    if (normalizedKarma >= band.minKarma) {
      limit = band.limit;
    }
  }

  return Math.max(1, limit);
}
