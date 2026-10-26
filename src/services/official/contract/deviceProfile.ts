export interface EndfieldDeviceProfile {
  version: 3;
  userAgent: string;
  secChUa?: string;
  secChUaMobile?: string;
  secChUaPlatform?: string;
  deviceModel: string;
  osVersion: string;
  deviceType: string;
  platform: "android" | "ios" | "windows";
  deviceId: string;
}

function isEndfieldDeviceProfile(value: unknown): value is EndfieldDeviceProfile {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<EndfieldDeviceProfile>;
  return (
    candidate.version === 3 &&
    typeof candidate.userAgent === "string" &&
    candidate.userAgent.length >= 32 &&
    (candidate.secChUa === undefined || typeof candidate.secChUa === "string") &&
    (candidate.secChUaMobile === undefined || typeof candidate.secChUaMobile === "string") &&
    (candidate.secChUaPlatform === undefined || typeof candidate.secChUaPlatform === "string") &&
    typeof candidate.deviceModel === "string" &&
    candidate.deviceModel.length > 0 &&
    typeof candidate.osVersion === "string" &&
    candidate.osVersion.length > 0 &&
    typeof candidate.deviceType === "string" &&
    candidate.deviceType.length > 0 &&
    typeof candidate.deviceId === "string" &&
    /^[A-Za-z0-9+/=_-]{20,256}$/.test(candidate.deviceId) &&
    (candidate.platform === "android" ||
      candidate.platform === "ios" ||
      candidate.platform === "windows")
  );
}

export function parseEndfieldDeviceProfile(
  value: string | null | undefined,
): EndfieldDeviceProfile | null {
  if (!value) {
    return null;
  }
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
    ...(profile.secChUaPlatform ? { secChUaPlatform: profile.secChUaPlatform } : {}),
  });
}
