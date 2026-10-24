import type { getEndfieldPosition } from "@/services/official/client/positionSocket";

export type PositionCacheEntry = {
  data: Awaited<ReturnType<typeof getEndfieldPosition>>;
  refreshedAt: number;
};
