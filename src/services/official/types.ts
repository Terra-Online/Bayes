import type { EndfieldMapMarkListEnvelope } from "@/services/official/client/types";

export type OfficialMapMark = {
  id: string;
  isUserMarked: boolean;
};

export type OfficialMarksResult = {
  raw: Record<"map01" | "map02", EndfieldMapMarkListEnvelope>;
  markers: OfficialMapMark[];
};
