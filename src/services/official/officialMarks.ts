// Keep the owner-provided lookup at its existing path to preserve local data setup.
import officialMarkerHashToPointId from "@/routes/binding/officialMarkerHashToPointId.json";
import type { DecryptedBinding } from "@/services/official/auth/types";
import { getEndfieldMapMarkList } from "@/services/official/client/mapClient";
import type { OfficialMapMark, OfficialMarksResult } from "@/services/official/types";
import type { Bindings } from "@/types/app";

import {
  createCredentialRecoveryScope,
  readBindingCredentials,
  recoverBindingCredentials,
} from "./auth/credentials";

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
  const candidate =
    record.marker && typeof record.marker === "object"
      ? (record.marker as Record<string, unknown>)
      : record;
  if (
    (typeof candidate.id === "string" || typeof candidate.id === "number") &&
    typeof candidate.isUserMarked === "boolean"
  ) {
    output.push({
      id: String(candidate.id),
      isUserMarked: candidate.isUserMarked,
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

async function getOfficialMarks(binding: DecryptedBinding): Promise<OfficialMarksResult> {
  const [map01, map02] = await Promise.all([
    getEndfieldMapMarkList({
      provider: binding.binding.provider,
      roleId: binding.binding.role_id,
      serverId: Number(binding.binding.server_id),
      mapId: "map01",
      cred: binding.cred,
      token: binding.token,
      deviceProfile: binding.deviceProfile,
    }),
    getEndfieldMapMarkList({
      provider: binding.binding.provider,
      roleId: binding.binding.role_id,
      serverId: Number(binding.binding.server_id),
      mapId: "map02",
      cred: binding.cred,
      token: binding.token,
      deviceProfile: binding.deviceProfile,
    }),
  ]);

  const raw = { map01, map02 };
  return {
    raw,
    markers: collectOfficialMarkers(raw),
  };
}

function officialMarkedPointIds(markedIds: string[]): string[] {
  return [
    ...new Set(
      markedIds
        .map((id) => OFFICIAL_MARKER_HASH_TO_POINT_ID[id.toLowerCase()])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
}

export async function readOfficialMarks(input: { uid: string }, env: Bindings) {
  let binding = await readBindingCredentials(input, env);
  let result: OfficialMarksResult;
  try {
    result = await getOfficialMarks(binding);
  } catch (rejection) {
    binding = await recoverBindingCredentials(
      { uid: input.uid, rejectedCredentials: binding, rejection },
      { env, recoveryScope: createCredentialRecoveryScope() },
    );
    // Preserve the existing single retry. A recovered identity can still be rejected.
    result = await getOfficialMarks(binding);
  }
  const markedIds = [
    ...new Set(result.markers.filter((marker) => marker.isUserMarked).map((marker) => marker.id)),
  ];
  return {
    binding: binding.publicBinding,
    timestamp: new Date().toISOString(),
    markedIds,
    pointIds: officialMarkedPointIds(markedIds),
    markers: result.markers,
    raw: result.raw,
  };
}
