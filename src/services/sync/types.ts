import type { EndfieldMapMarkListEnvelope } from "@/lib/endfieldClient/types";

export type OfficialMapMark = {
  id: string;
  isUserMarked: boolean;
};

export type OfficialMarksResult = {
  raw: Record<"map01" | "map02", EndfieldMapMarkListEnvelope>;
  markers: OfficialMapMark[];
};
