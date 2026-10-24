import { createClient as createSklandClient } from "skland-kit";

import type { EndfieldDeviceProfile } from "@/services/official/contract/deviceProfile";

import { createDeviceId } from "./signature";
import { ENDFIELD_USER_AGENT_POOL } from "./userAgentPool";

export const SKLAND_DEVICE_PROFILE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0";

function randomInt(maxExclusive: number): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] % maxExclusive;
}

function getBrowserMajor(userAgent: string): number {
  const match = userAgent.match(/(?:Chrome|Edg)\/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function detectUserAgentPlatform(userAgent: string): string {
  if (/iPad/.test(userAgent)) {
    return "iPad";
  }
  if (/iPhone/.test(userAgent)) {
    return "iPhone";
  }
  if (/Android/.test(userAgent)) {
    return "Linux armv81";
  }
  return "Win32";
}

function parseDeviceProfile(
  userAgent: string,
  platform: string,
): Pick<
  EndfieldDeviceProfile,
  "platform" | "deviceModel" | "osVersion" | "secChUa" | "secChUaMobile" | "secChUaPlatform"
> {
  if (platform === "iPhone" || platform === "iPad") {
    const os = userAgent.match(/CPU (?:iPhone )?OS ([\d_]+)/)?.[1]?.replace(/_/g, ".") ?? "18.7";
    return {
      platform: platform === "iPad" ? "ios" : "ios",
      deviceModel: platform,
      osVersion: `${platform === "iPad" ? "iPadOS" : "iOS"} ${os}`,
    };
  }

  if (platform.startsWith("Linux ")) {
    const os = userAgent.match(/Android ([\d.]+)/)?.[1] ?? "15";
    const model =
      userAgent.match(/Android [\d.]+; ([^)]+?)(?: Build\/[^)]+)?\)/)?.[1] ?? "Android Device";
    const major = getBrowserMajor(userAgent);
    return {
      platform: "android",
      deviceModel: model,
      osVersion: `Android ${os}`,
      secChUa: `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="99"`,
      secChUaMobile: "?1",
      secChUaPlatform: '"Android"',
    };
  }

  const major = getBrowserMajor(userAgent);
  const edge = /Edg\//.test(userAgent);
  return {
    platform: "windows",
    deviceModel: "Windows PC",
    osVersion: "Windows 11",
    secChUa: `"Chromium";v="${major}", "${edge ? "Microsoft Edge" : "Google Chrome"}";v="${major}", "Not?A_Brand";v="99"`,
    secChUaMobile: "?0",
    secChUaPlatform: '"Windows"',
  };
}

export function createEndfieldDeviceProfile(
  deviceIdOverride?: string,
  userAgentOverride?: string,
): EndfieldDeviceProfile {
  const suppliedUserAgent = userAgentOverride?.trim();
  const userAgent =
    suppliedUserAgent ?? ENDFIELD_USER_AGENT_POOL[randomInt(ENDFIELD_USER_AGENT_POOL.length)];
  const parsed = parseDeviceProfile(userAgent, detectUserAgentPlatform(userAgent));
  return {
    version: 3,
    ...parsed,
    deviceType: "7",
    deviceId: deviceIdOverride?.trim().replace(/^B/i, "") || createDeviceId(),
    userAgent,
  };
}

export async function createEndfieldDeviceId(): Promise<string> {
  const values = new Map<string, string>();
  const driver = {
    async hasItem(key: string) {
      return values.has(key);
    },
    async getItem(key: string) {
      return values.get(key);
    },
    async getKeys() {
      return [...values.keys()];
    },
    async setItem(key: string, value: string) {
      values.set(key, value);
    },
    async removeItem(key: string) {
      values.delete(key);
    },
  };
  const client = createSklandClient({ driver });
  try {
    await client.signIn("");
  } catch {
    // signIn reaches the credential endpoint after the device profile is created.
  }
  const deviceId = values.get("skland:did");
  if (!deviceId) {
    throw new Error("Skland device profile service did not return a device id.");
  }
  return deviceId;
}
