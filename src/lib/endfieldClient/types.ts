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

export type ApiEnvelope<T> = {
  code: number;
  message?: string;
  data: T;
};

export type ApiEnvelopeOptions = {
  positionRequest?: boolean;
};

export type AuthEnvelope<T> = {
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

export type EmailPasswordTokenData = {
  accountToken?: string;
  token?: string;
};

export type PhoneCodeTokenData = {
  token: string;
  hgId?: string;
};

export type OauthGrantData = {
  code: string;
  token?: string;
  uid?: string;
};

export type GenerateCredData = {
  cred: string;
  token: string;
};

export type RefreshAuthData = {
  cred?: string;
  token?: string;
};

export type WebSocketTokenData = {
  token: string;
};

export type EndfieldMapId = "map01" | "map02";

export type EndfieldMapMarkListEnvelope = ApiEnvelope<unknown>;

export type BindingRole = {
  serverId: string;
  roleId: string;
  nickname?: string;
  level?: number;
  isDefault?: boolean;
  serverType?: string;
  serverName?: string;
};

export type PlayerBindingData = {
  list?: Array<{
    appCode?: string;
    bindingList?: Array<{
      roles?: BindingRole[];
      defaultRole?: BindingRole;
    }>;
  }>;
};

export type EndfieldHostConfig = {
  appCode: string;
  baseUrl: string;
  wsBaseUrl: string;
  authBaseUrl: string;
};
