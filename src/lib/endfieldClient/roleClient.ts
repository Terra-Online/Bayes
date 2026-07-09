import { ApiError } from "../errors";
import { parseApiEnvelope } from "./envelope";
import { buildDeviceHeaders, buildUrl, getEndfieldHosts } from "./hosts";
import { getSignature } from "./signature";
import type { EndfieldDeviceProfile, EndfieldProvider, EndfieldRoleOption, PlayerBindingData } from "./types";

export async function getEndfieldRoles(
  provider: EndfieldProvider,
  cred: string,
  token: string,
  deviceProfile?: EndfieldDeviceProfile
): Promise<EndfieldRoleOption[]> {
  const hosts = getEndfieldHosts(provider);
  const path = "/api/v1/game/player/binding";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = await getSignature(path, timestamp, token, "");

  const response = await fetch(buildUrl(hosts.baseUrl, path), {
    method: "GET",
    headers: {
      accept: "*/*",
      cred,
      platform: "3",
      timestamp,
      vname: "1.0.0",
      sign,
      "accept-language": "en-US",
      "sk-language": "en",
      ...buildDeviceHeaders(deviceProfile)
    }
  });

  if (response.status === 404) {
    throw new ApiError(404, "ENDFIELD_ROLE_NOT_FOUND", "No Endfield roles found on this account.", {
      upstreamStatus: response.status,
      provider
    });
  }

  const data = await parseApiEnvelope<PlayerBindingData>(response);
  const entry = (data.list ?? []).find((item) => item.appCode === "endfield");
  const roles = entry?.bindingList?.[0]?.roles ?? [];

  return roles
    .map((role): EndfieldRoleOption | null => {
      const serverId = Number(role.serverId);
      if (!role.roleId || !Number.isFinite(serverId)) {
        return null;
      }
      return {
        serverId,
        roleId: role.roleId,
        nickname: role.nickname || "Unknown",
        level: role.level ?? 0,
        serverType: role.serverType ?? "",
        serverName: role.serverName ?? "",
        isDefault: Boolean(role.isDefault)
      };
    })
    .filter((role): role is EndfieldRoleOption => Boolean(role));
}
