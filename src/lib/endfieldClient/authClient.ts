import { ApiError, isApiError } from "../errors";
import { parseApiEnvelope, parseAuthEnvelope } from "./envelope";
import { buildDeviceHeaders, buildUrl, getEndfieldHosts } from "./hosts";
import { getSignature } from "./signature";
import type {
  EmailPasswordTokenData,
  EndfieldCaptchaSolution,
  EndfieldDeviceProfile,
  EndfieldProvider,
  GenerateCredData,
  OauthGrantData,
  PhoneCodeTokenData,
  RefreshAuthData
} from "./types";

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

export async function refreshEndfieldAuth(args: {
  provider: EndfieldProvider;
  cred?: string;
  deviceProfile?: EndfieldDeviceProfile;
}): Promise<RefreshAuthData> {
  const hosts = getEndfieldHosts(args.provider);
  const path = "/web/v1/auth/refresh";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = await getSignature(path, timestamp, args.cred ?? "");

  const response = await fetch(buildUrl(hosts.baseUrl, path), {
    method: "GET",
    headers: {
      accept: "*/*",
      ...(args.cred ? { cred: args.cred } : {}),
      platform: "3",
      timestamp,
      vname: "1.0.0",
      sign,
      "accept-language": "en-US",
      "sk-language": "en",
      ...buildDeviceHeaders(args.deviceProfile)
    }
  });

  const data = await parseApiEnvelope<RefreshAuthData>(response);
  if (!data.token) {
    throw new ApiError(502, "ENDFIELD_REFRESH_TOKEN_MISSING", "Auth refresh response did not include a token.");
  }
  return data;
}
