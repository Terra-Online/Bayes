import { parseApiEnvelope, parseRawApiEnvelope } from "./envelope";
import { buildDeviceHeaders, buildUrl, getEndfieldHosts } from "./hosts";
import { getEndfieldTimestamp, getSignature } from "./signature";
import type {
  EndfieldDeviceProfile,
  EndfieldMapId,
  EndfieldMapMarkListEnvelope,
  EndfieldProvider
} from "./types";

export async function getEndfieldMapMarkList(args: {
  provider: EndfieldProvider;
  roleId: string;
  serverId: number;
  mapId: EndfieldMapId;
  cred: string;
  token: string;
  deviceProfile?: EndfieldDeviceProfile;
}): Promise<EndfieldMapMarkListEnvelope> {
  const hosts = getEndfieldHosts(args.provider);
  const path = "/web/v1/game/endfield/map/mark/list";
  const signPath = `${path}mapId=${args.mapId}&roleId=${args.roleId}&serverId=${args.serverId}`;
  const timestamp = getEndfieldTimestamp();
  const sign = await getSignature(signPath, timestamp, args.token, "", args.deviceProfile?.deviceId ?? "");
  const query = new URLSearchParams({
    mapId: args.mapId,
    roleId: args.roleId,
    serverId: String(args.serverId)
  });
  const origin = args.provider === "skland"
    ? "https://game.skland.com"
    : "https://game.skport.com";

  const response = await fetch(`${buildUrl(hosts.baseUrl, path)}?${query.toString()}`, {
    method: "GET",
    headers: {
      accept: "*/*",
      cred: args.cred,
      origin,
      platform: "3",
      referer: `${origin}/`,
      timestamp,
      vname: "1.0.0",
      sign,
      "accept-language": "en-US",
      "sk-language": "en",
      ...buildDeviceHeaders(args.deviceProfile)
    }
  });

  return parseRawApiEnvelope(response);
}

export async function agreePolicy(args: {
  provider: EndfieldProvider;
  roleId: string;
  serverId: number;
  cred: string;
  token: string;
  deviceProfile?: EndfieldDeviceProfile;
}): Promise<void> {
  const hosts = getEndfieldHosts(args.provider);
  const path = "/web/v1/game/endfield/map/agree-policy";
  const body = JSON.stringify({
    roleId: args.roleId,
    serverId: String(args.serverId)
  });
  const timestamp = getEndfieldTimestamp();
  const sign = await getSignature(path, timestamp, args.token, body, args.deviceProfile?.deviceId ?? "");
  const origin = args.provider === "skland"
    ? "https://game.skland.com"
    : "https://game.skport.com";

  const response = await fetch(buildUrl(hosts.baseUrl, path), {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      cred: args.cred,
      origin,
      platform: "3",
      referer: `${origin}/`,
      timestamp,
      vname: "1.0.0",
      sign,
      "accept-language": "en-US",
      "sk-language": "en",
      ...buildDeviceHeaders(args.deviceProfile)
    },
    body
  });

  await parseApiEnvelope<void>(response);
}
