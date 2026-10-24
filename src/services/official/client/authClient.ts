import { ApiError, isApiError } from "@/lib/errors";
import type { EndfieldDeviceProfile } from "@/services/official/contract/deviceProfile";
import type { EndfieldProvider } from "@/services/official/contract/provider";

import { parseApiEnvelope, parseAuthEnvelope } from "./envelope";
import { buildDeviceHeaders, buildUrl, getEndfieldHosts } from "./hosts";
import { getEndfieldTimestamp, getSignature } from "./signature";
import type { GenerateCredData, OauthGrantData, RefreshAuthData } from "./types";

export async function grantEndfieldOAuthCode(
  provider: EndfieldProvider,
  accountToken: string,
  deviceProfile?: EndfieldDeviceProfile,
): Promise<OauthGrantData> {
  const hosts = getEndfieldHosts(provider);
  const response = await fetch(buildUrl(hosts.authBaseUrl, "/user/oauth2/v2/grant"), {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json;charset=UTF-8",
      origin: provider === "skland" ? "https://www.skland.com" : "https://www.skport.com",
      referer: provider === "skland" ? "https://www.skland.com/" : "https://www.skport.com/",
      ...(provider === "skland" ? { "x-requested-with": "com.hypergryph.skland" } : {}),
      ...buildDeviceHeaders(deviceProfile),
    },
    body: JSON.stringify({
      token: accountToken,
      appCode: hosts.appCode,
      type: 0,
    }),
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
          rejectedAuthBaseUrl: hosts.authBaseUrl,
        },
      );
    }
    throw error;
  }
  if (!data.code) {
    throw new ApiError(
      502,
      "ENDFIELD_CODE_MISSING",
      "OAuth grant response did not include a code.",
    );
  }
  return data;
}

export async function generateEndfieldCredByCode(
  provider: EndfieldProvider,
  code: string,
  deviceProfile?: EndfieldDeviceProfile,
): Promise<GenerateCredData> {
  const hosts = getEndfieldHosts(provider);
  const timestamp = getEndfieldTimestamp();
  const response = await fetch(buildUrl(hosts.baseUrl, "/web/v1/user/auth/generate_cred_by_code"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept-language": "en-US",
      origin: provider === "skland" ? "https://www.skland.com" : "https://www.skport.com",
      referer: provider === "skland" ? "https://www.skland.com/" : "https://www.skport.com/",
      platform: "3",
      timestamp,
      vname: "1.0.0",
      ...buildDeviceHeaders(deviceProfile),
    },
    body: JSON.stringify({ kind: 1, code }),
  });

  const data = await parseApiEnvelope<GenerateCredData>(response);
  if (!data.cred || !data.token) {
    throw new ApiError(
      502,
      "ENDFIELD_CREDENTIAL_MISSING",
      "Cred generation response did not include credentials.",
    );
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
  const timestamp = getEndfieldTimestamp();
  const sign = await getSignature(
    path,
    timestamp,
    args.cred ?? "",
    "",
    args.deviceProfile?.deviceId ?? "",
  );

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
      ...buildDeviceHeaders(args.deviceProfile),
    },
  });

  const data = await parseApiEnvelope<RefreshAuthData>(response);
  if (!data.token) {
    throw new ApiError(
      502,
      "ENDFIELD_REFRESH_TOKEN_MISSING",
      "Auth refresh response did not include a token.",
    );
  }
  return data;
}
