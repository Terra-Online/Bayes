import { createHash } from "node:crypto";
import deviceProfilePool from "./endfield-client-ua.json";
import { ApiError, isApiError } from "./errors";

const textEncoder = new TextEncoder();

export type EndfieldProvider = "skland" | "skport";

export interface EndfieldRoleOption {
  serverId: number;
  roleId: string;
  nickname: string;
  level: number;
  serverType: string;
  serverName: string;
  isDefault: boolean;
}

export interface EndfieldPositionData {
  pos: {
    x: number;
    y: number;
    z: number;
  };
  levelId: string;
  isOnline: boolean;
  mapId: string;
}

export interface EndfieldDeviceProfile {
  version: 1;
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

type ApiEnvelope<T> = {
  code: number;
  message?: string;
  data: T;
};

type ApiEnvelopeOptions = {
  positionRequest?: boolean;
};

type AuthEnvelope<T> = {
  status: number;
  msg?: string;
  data: T;
};

export type EndfieldCaptchaChallenge = {
  geetestId?: string;
  challenge?: string;
  riskType?: string;
};

export type EndfieldCaptchaSolution = {
  captcha?: {
    captcha_id: string;
    lot_number: string;
    pass_token: string;
    gen_time: string;
    captcha_output: string;
    challenge?: string;
  };
  challenge?: string;
  validate?: string;
  seccode?: string;
  geetest_challenge?: string;
  geetest_validate?: string;
  geetest_seccode?: string;
};

type EmailPasswordTokenData = {
  accountToken?: string;
  token?: string;
};

type PhoneCodeTokenData = {
  token: string;
  hgId?: string;
};

type OauthGrantData = {
  code: string;
  token?: string;
  uid?: string;
};

type GenerateCredData = {
  cred: string;
  token: string;
};

type BindingRole = {
  serverId: string;
  roleId: string;
  nickname?: string;
  level?: number;
  isDefault?: boolean;
  serverType?: string;
  serverName?: string;
};

type PlayerBindingData = {
  list?: Array<{
    appCode?: string;
    bindingList?: Array<{
      roles?: BindingRole[];
      defaultRole?: BindingRole;
    }>;
  }>;
};

type EndfieldHostConfig = {
  appCode: string;
  baseUrl: string;
  authBaseUrl: string;
};

const HOSTS: Record<EndfieldProvider, EndfieldHostConfig> = {
  skland: {
    appCode: "4ca99fa6b56cc2ba",
    baseUrl: "https://zonai.skland.com",
    authBaseUrl: "https://as.hypergryph.com"
  },
  skport: {
    appCode: "6eb76d4e13aa36e6",
    baseUrl: "https://zonai.skport.com",
    authBaseUrl: "https://as.gryphline.com"
  }
};

type EndfieldDeviceProfileTemplate = Omit<EndfieldDeviceProfile, "deviceId">;

const DEVICE_PROFILE_POOL = deviceProfilePool as unknown as ReadonlyArray<EndfieldDeviceProfileTemplate>;

function buildUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//.test(path)) {
    return path;
  }
  return `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return toHex(new Uint8Array(signature));
}

async function getSignature(path: string, timestamp: string, token: string, body = ""): Promise<string> {
  const headerJson = JSON.stringify({
    platform: "3",
    timestamp,
    dId: "",
    vName: "1.0.0"
  });

  const hmacHex = await hmacSha256Hex(path + body + timestamp + headerJson, token);
  return createHash("md5").update(hmacHex).digest("hex");
}

function createDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

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

async function parseApiEnvelope<T>(response: Response, options: ApiEnvelopeOptions = {}): Promise<T> {
  const json = await response.json<ApiEnvelope<T>>().catch(() => null);
  if (!json) {
    throw new ApiError(502, "ENDFIELD_BAD_RESPONSE", `Failed to parse upstream response (${response.status}).`);
  }

  if (!response.ok || json.code !== 0) {
    if (options.positionRequest) {
      throw new ApiError(
        401,
        "ENDFIELD_POSITION_UNAVAILABLE",
        "Player is not currently logged into the game or position is unavailable.",
        {
          upstreamCode: json.code,
          upstreamStatus: response.status,
          upstreamMessage: json.message
        }
      );
    }

    if (response.status === 401 || response.status === 403 || json.code === 401 || json.code === 403) {
      throw new ApiError(
        401,
        "ENDFIELD_CREDENTIAL_REJECTED",
        json.message ?? "Endfield credential was rejected.",
        {
          upstreamCode: json.code,
          upstreamStatus: response.status
        }
      );
    }

    throw new ApiError(
      502,
      "ENDFIELD_UPSTREAM_REJECTED",
      json.message ?? "Upstream rejected request.",
      {
        upstreamCode: json.code,
        upstreamStatus: response.status
      }
    );
  }

  return json.data;
}

async function parseAuthEnvelope<T>(response: Response): Promise<T> {
  const json = await response.json<AuthEnvelope<T>>().catch(() => null);
  if (!json) {
    throw new ApiError(502, "ENDFIELD_BAD_RESPONSE", `Failed to parse auth response (${response.status}).`);
  }

  if (!response.ok || json.status !== 0) {
    const captcha = (json.data as { captcha?: EndfieldCaptchaChallenge } | undefined)?.captcha;
    if (captcha) {
      throw new ApiError(409, "ENDFIELD_CAPTCHA_REQUIRED", json.msg ?? "Human-machine verification required.", captcha);
    }
    throw new ApiError(response.status === 401 || response.status === 403 ? 401 : 502, "ENDFIELD_AUTH_REJECTED", json.msg ?? "Auth upstream rejected request.");
  }

  return json.data;
}

export function getEndfieldHosts(provider: EndfieldProvider): EndfieldHostConfig {
  return HOSTS[provider];
}

function buildDeviceHeaders(profile?: EndfieldDeviceProfile, deviceId = profile?.deviceId): Record<string, string> {
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

export async function requestEndfieldAccountTokenByEmailPassword(args: {
  provider: EndfieldProvider;
  email: string;
  password: string;
  captcha?: EndfieldCaptchaSolution;
  deviceProfile?: EndfieldDeviceProfile;
}): Promise<string> {
  const hosts = getEndfieldHosts(args.provider);
  const captchaPayload = args.captcha?.captcha
    ? {
      ...args.captcha.captcha,
      challenge: args.captcha.captcha.challenge ?? args.captcha.challenge ?? args.captcha.geetest_challenge
    }
    : null;
  const normalizedCaptcha = args.captcha
    ? {
      challenge: args.captcha.challenge ?? args.captcha.geetest_challenge,
      validate: args.captcha.validate ?? args.captcha.geetest_validate,
      seccode: args.captcha.seccode ?? args.captcha.geetest_seccode
    }
    : null;

  const response = await fetch(buildUrl(hosts.authBaseUrl, "/user/auth/v1/token_by_email_password"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept-language": "en-US",
      "x-language": "en-us",
      ...buildDeviceHeaders(args.deviceProfile)
    },
    body: JSON.stringify({
      email: args.email,
      password: args.password,
      ...(captchaPayload ? { captcha: captchaPayload } : {}),
      ...(normalizedCaptcha
        ? {
          challenge: normalizedCaptcha.challenge,
          validate: normalizedCaptcha.validate,
          seccode: normalizedCaptcha.seccode,
          geetest_challenge: normalizedCaptcha.challenge,
          geetest_validate: normalizedCaptcha.validate,
          geetest_seccode: normalizedCaptcha.seccode
        }
        : {})
    })
  });

  const data = await parseAuthEnvelope<EmailPasswordTokenData>(response);
  const token = data.accountToken ?? data.token;
  if (!token) {
    throw new ApiError(502, "ENDFIELD_ACCOUNT_TOKEN_MISSING", "Auth response did not include an account token.");
  }
  return token;
}

export async function sendSklandPhoneCodeBackup(
  phone: string,
  deviceId: string,
  deviceProfile?: EndfieldDeviceProfile
): Promise<void> {
  const hosts = getEndfieldHosts("skland");
  const response = await fetch(buildUrl(hosts.authBaseUrl, "/general/v1/send_phone_code"), {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json;charset=UTF-8",
      ...buildDeviceHeaders(deviceProfile, deviceId)
    },
    body: JSON.stringify({
      phone,
      type: 2
    })
  });

  await parseAuthEnvelope<Record<string, unknown>>(response);
}

async function exchangePhoneTokenToCred(
  phoneToken: string,
  deviceId: string,
  deviceProfile?: EndfieldDeviceProfile
): Promise<GenerateCredData> {
  const hosts = getEndfieldHosts("skland");
  const grantResponse = await fetch(buildUrl(hosts.authBaseUrl, "/user/oauth2/v2/grant"), {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json;charset=UTF-8",
      ...buildDeviceHeaders(deviceProfile, deviceId)
    },
    body: JSON.stringify({
      token: phoneToken,
      appCode: hosts.appCode,
      type: 0
    })
  });
  const grant = await parseAuthEnvelope<OauthGrantData>(grantResponse);
  return generateEndfieldCredByCode("skland", grant.code, deviceProfile);
}

export async function generateSklandCredByPhoneCodeBackup(args: {
  phone: string;
  verificationCode: string;
  deviceId: string;
  deviceProfile?: EndfieldDeviceProfile;
}): Promise<GenerateCredData> {
  const hosts = getEndfieldHosts("skland");
  const response = await fetch(buildUrl(hosts.authBaseUrl, "/user/auth/v2/token_by_phone_code"), {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json;charset=UTF-8",
      ...buildDeviceHeaders(args.deviceProfile, args.deviceId)
    },
    body: JSON.stringify({
      phone: args.phone,
      code: args.verificationCode,
      appCode: hosts.appCode
    })
  });
  const data = await parseAuthEnvelope<PhoneCodeTokenData>(response);
  return exchangePhoneTokenToCred(data.token, args.deviceId, args.deviceProfile);
}

export async function generateSklandCredByPhonePasswordBackup(args: {
  phone: string;
  password: string;
  deviceId: string;
  deviceProfile?: EndfieldDeviceProfile;
}): Promise<GenerateCredData> {
  const hosts = getEndfieldHosts("skland");
  const response = await fetch(buildUrl(hosts.authBaseUrl, "/user/auth/v1/token_by_phone_password"), {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json;charset=UTF-8",
      ...buildDeviceHeaders(args.deviceProfile, args.deviceId)
    },
    body: JSON.stringify({
      phone: args.phone,
      password: args.password
    })
  });
  const data = await parseAuthEnvelope<PhoneCodeTokenData>(response);
  return exchangePhoneTokenToCred(data.token, args.deviceId, args.deviceProfile);
}

export async function grantEndfieldOAuthCode(
  provider: EndfieldProvider,
  accountToken: string,
  deviceProfile?: EndfieldDeviceProfile
): Promise<OauthGrantData> {
  const hosts = getEndfieldHosts(provider);
  const response = await fetch(buildUrl(hosts.authBaseUrl, "/user/oauth2/v2/grant"), {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json;charset=UTF-8",
      ...buildDeviceHeaders(deviceProfile)
    },
    body: JSON.stringify({
      token: accountToken,
      appCode: hosts.appCode,
      type: 0
    })
  });

  let data: OauthGrantData;
  try {
    data = await parseAuthEnvelope<OauthGrantData>(response);
  } catch (error) {
    if (provider === "skport" && isApiError(error) && error.code === "ENDFIELD_AUTH_REJECTED") {
      throw new ApiError(
        401,
        "ENDFIELD_GRYPHLINE_TOKEN_INVALID",
        "Invalid Gryphline account token. Please copy the full response from https://web-api.gryphline.com/cookie_store/account_token.",
        {
          expectedTokenSource: "https://web-api.gryphline.com/cookie_store/account_token",
          rejectedAuthBaseUrl: hosts.authBaseUrl
        }
      );
    }
    throw error;
  }
  if (!data.code) {
    throw new ApiError(502, "ENDFIELD_CODE_MISSING", "OAuth grant response did not include a code.");
  }
  return data;
}

export async function generateEndfieldCredByCode(
  provider: EndfieldProvider,
  code: string,
  deviceProfile?: EndfieldDeviceProfile
): Promise<GenerateCredData> {
  const hosts = getEndfieldHosts(provider);
  const response = await fetch(buildUrl(hosts.baseUrl, "/web/v1/user/auth/generate_cred_by_code"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept-language": "en-US",
      ...buildDeviceHeaders(deviceProfile)
    },
    body: JSON.stringify({ kind: 1, code })
  });

  const data = await parseApiEnvelope<GenerateCredData>(response);
  if (!data.cred || !data.token) {
    throw new ApiError(502, "ENDFIELD_CREDENTIAL_MISSING", "Cred generation response did not include credentials.");
  }
  return data;
}

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

export async function getEndfieldPosition(args: {
  provider: EndfieldProvider;
  roleId: string;
  serverId: number;
  cred: string;
  token: string;
  deviceProfile?: EndfieldDeviceProfile;
}): Promise<EndfieldPositionData> {
  const hosts = getEndfieldHosts(args.provider);
  const path = "/web/v1/game/endfield/map/me/position";
  const signPath = `${path}roleId=${args.roleId}&serverId=${args.serverId}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = await getSignature(signPath, timestamp, args.token);
  const query = new URLSearchParams({
    roleId: args.roleId,
    serverId: String(args.serverId)
  });

  const response = await fetch(`${buildUrl(hosts.baseUrl, path)}?${query.toString()}`, {
    method: "GET",
    headers: {
      cred: args.cred,
      platform: "3",
      timestamp,
      vname: "1.0.0",
      sign,
      "accept-language": "en-US",
      ...buildDeviceHeaders(args.deviceProfile)
    }
  });

  return parseApiEnvelope<EndfieldPositionData>(response, { positionRequest: true });
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
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = await getSignature(path, timestamp, args.token, body);
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
