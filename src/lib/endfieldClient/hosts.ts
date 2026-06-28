import type { EndfieldDeviceProfile, EndfieldHostConfig, EndfieldProvider } from "./types";

const HOSTS: Record<EndfieldProvider, EndfieldHostConfig> = {
  skland: {
    appCode: "4ca99fa6b56cc2ba",
    baseUrl: "https://zonai.skland.com",
    wsBaseUrl: "wss://ws.skland.com/",
    authBaseUrl: "https://as.hypergryph.com"
  },
  skport: {
    appCode: "6eb76d4e13aa36e6",
    baseUrl: "https://zonai.skport.com",
    wsBaseUrl: "wss://ws.skport.com/",
    authBaseUrl: "https://as.gryphline.com"
  }
};

export function getEndfieldHosts(provider: EndfieldProvider): EndfieldHostConfig {
  return HOSTS[provider];
}

export function buildUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//.test(path)) {
    return path;
  }
  return `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export function buildWebSocketHttpUrl(baseUrl: string, path: string): string {
  return buildUrl(baseUrl, path)
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://");
}

export function buildDeviceHeaders(profile?: EndfieldDeviceProfile, deviceId = profile?.deviceId): Record<string, string> {
  if (!profile) return {};

  return {
    "user-agent": profile.userAgent,
    ...(profile.secChUa ? { "sec-ch-ua": profile.secChUa } : {}),
    ...(profile.secChUaMobile ? { "sec-ch-ua-mobile": profile.secChUaMobile } : {}),
    ...(profile.secChUaPlatform ? { "sec-ch-ua-platform": profile.secChUaPlatform } : {}),
    ...(deviceId ? { "x-deviceid": deviceId } : {}),
    "x-devicemodel": profile.deviceModel,
    "x-devicetype": profile.deviceType,
    "x-osver": profile.osVersion
  };
}
