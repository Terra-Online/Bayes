import type { getEndfieldPosition } from "@/lib/endfieldClient/positionSocket";

export type PositionCacheEntry = {
  data: Awaited<ReturnType<typeof getEndfieldPosition>>;
  refreshedAt: number;
};
