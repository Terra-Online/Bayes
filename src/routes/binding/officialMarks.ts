import officialMarkerHashToPointId from "./officialMarkerHashToPointId.json";
import { getEndfieldMapMarkList } from "../../lib/endfieldClient/mapClient";
import type { DecryptedBinding, OfficialMapMark, OfficialMarksResult } from "./types";

const OFFICIAL_MARKER_HASH_TO_POINT_ID = officialMarkerHashToPointId as Record<string, string>;

function collectOfficialMarkers(value: unknown, output: OfficialMapMark[] = []): OfficialMapMark[] {
  if (!value || typeof value !== "object") {
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectOfficialMarkers(item, output);
    }
    return output;
  }

  const record = value as Record<string, unknown>;
  const candidate = record.marker && typeof record.marker === "object"
    ? record.marker as Record<string, unknown>
    : record;
  if (
    (typeof candidate.id === "string" || typeof candidate.id === "number")
    && typeof candidate.isUserMarked === "boolean"
  ) {
    output.push({
      id: String(candidate.id),
      isUserMarked: candidate.isUserMarked
    });
    if (candidate !== record) {
      return output;
    }
  }

  for (const item of Object.values(record)) {
    collectOfficialMarkers(item, output);
  }
  return output;
}

export async function getOfficialMarks(binding: DecryptedBinding): Promise<OfficialMarksResult> {
  const [map01, map02] = await Promise.all([
    getEndfieldMapMarkList({
      provider: binding.binding.provider,
      roleId: binding.binding.role_id,
      serverId: Number(binding.binding.server_id),
      mapId: "map01",
      cred: binding.cred,
      token: binding.token,
      deviceProfile: binding.deviceProfile
    }),
    getEndfieldMapMarkList({
      provider: binding.binding.provider,
      roleId: binding.binding.role_id,
      serverId: Number(binding.binding.server_id),
      mapId: "map02",
      cred: binding.cred,
      token: binding.token,
      deviceProfile: binding.deviceProfile
    })
  ]);

  const raw = { map01, map02 };
  return {
    raw,
    markers: collectOfficialMarkers(raw)
  };
}

export function officialMarkedPointIds(markedIds: string[]): string[] {
  return [...new Set(markedIds
    .map((id) => OFFICIAL_MARKER_HASH_TO_POINT_ID[id.toLowerCase()])
    .filter((id): id is string => Boolean(id)))];
}
