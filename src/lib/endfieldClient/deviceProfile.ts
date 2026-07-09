import deviceProfilePool from "./deviceProfilePool.json";
import { createDeviceId } from "./signature";
import type { EndfieldDeviceProfile } from "./types";

type EndfieldDeviceProfileTemplate = Omit<EndfieldDeviceProfile, "deviceId">;

const DEVICE_PROFILE_POOL = deviceProfilePool as unknown as ReadonlyArray<EndfieldDeviceProfileTemplate>;

function isEndfieldDeviceProfile(value: unknown): value is EndfieldDeviceProfile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EndfieldDeviceProfile>;
  return candidate.version === 1
    && typeof candidate.userAgent === "string"
    && candidate.userAgent.length >= 32
    && (candidate.secChUa === undefined || typeof candidate.secChUa === "string")
    && (candidate.secChUaMobile === undefined || typeof candidate.secChUaMobile === "string")
    && (candidate.secChUaPlatform === undefined || typeof candidate.secChUaPlatform === "string")
    && typeof candidate.deviceModel === "string"
    && candidate.deviceModel.length > 0
    && typeof candidate.osVersion === "string"
    && candidate.osVersion.length > 0
    && typeof candidate.deviceType === "string"
    && candidate.deviceType.length > 0
    && typeof candidate.deviceId === "string"
    && /^[a-f0-9]{16,64}$/i.test(candidate.deviceId)
    && (candidate.platform === "android" || candidate.platform === "ios" || candidate.platform === "windows");
}

export function createEndfieldDeviceProfile(): EndfieldDeviceProfile {
  const index = crypto.getRandomValues(new Uint32Array(1))[0] % DEVICE_PROFILE_POOL.length;
  const base = DEVICE_PROFILE_POOL[index];
  return {
    ...base,
    deviceId: createDeviceId()
  };
}

export function parseEndfieldDeviceProfile(value: string | null | undefined): EndfieldDeviceProfile | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return isEndfieldDeviceProfile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function serializeEndfieldDeviceProfile(profile: EndfieldDeviceProfile): string {
  return JSON.stringify({
    version: profile.version,
    platform: profile.platform,
    deviceModel: profile.deviceModel,
    osVersion: profile.osVersion,
    deviceType: profile.deviceType,
    deviceId: profile.deviceId,
    userAgent: profile.userAgent,
    ...(profile.secChUa ? { secChUa: profile.secChUa } : {}),
    ...(profile.secChUaMobile ? { secChUaMobile: profile.secChUaMobile } : {}),
    ...(profile.secChUaPlatform ? { secChUaPlatform: profile.secChUaPlatform } : {})
  });
}
