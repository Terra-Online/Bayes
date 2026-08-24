import { ApiError } from "../errors";
import type {
  ApiEnvelope,
  ApiEnvelopeOptions,
  AuthEnvelope,
  EndfieldCaptchaChallenge,
  EndfieldMapMarkListEnvelope
} from "./types";

export async function parseApiEnvelope<T>(response: Response, options: ApiEnvelopeOptions = {}): Promise<T> {
  const json = await response.json<ApiEnvelope<T>>().catch(() => null);
  if (!json) {
    throw new ApiError(502, "ENDFIELD_BAD_RESPONSE", `Failed to parse upstream response (${response.status}).`);
  }

  if (!response.ok || json.code !== 0) {
    if (json.code === 10001) {
      throw new ApiError(
        502,
        "ENDFIELD_DEVICE_REJECTED",
        json.message ?? "Endfield device information was rejected.",
        {
          upstreamCode: json.code,
          upstreamStatus: response.status,
          upstreamMessage: json.message
        }
      );
    }
    if (options.positionRequest) {
      if (!response.ok && response.status !== 401 && response.status !== 403) {
        throw new ApiError(
          502,
          "ENDFIELD_POSITION_UPSTREAM_UNAVAILABLE",
          "Endfield position upstream was unavailable.",
          {
            upstreamCode: json.code,
            upstreamStatus: response.status,
            upstreamMessage: json.message
          }
        );
      }
      if (json.code === 10000 || json.code === 10002) {
        throw new ApiError(
          401,
          "ENDFIELD_CREDENTIAL_REJECTED",
          json.message ?? "Endfield credential was rejected.",
          {
            upstreamCode: json.code,
            upstreamStatus: response.status,
            upstreamMessage: json.message
          }
        );
      }
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

export async function parseRawApiEnvelope(response: Response): Promise<EndfieldMapMarkListEnvelope> {
  const json = await response.json<ApiEnvelope<unknown>>().catch(() => null);
  if (!json) {
    throw new ApiError(502, "ENDFIELD_BAD_RESPONSE", `Failed to parse upstream response (${response.status}).`);
  }

  if (!response.ok || json.code !== 0) {
    if (response.status === 401 || response.status === 403 || json.code === 401 || json.code === 403 || json.code === 10000) {
      throw new ApiError(
        401,
        "ENDFIELD_CREDENTIAL_REJECTED",
        json.message ?? "Endfield credential was rejected.",
        {
          upstreamCode: json.code,
          upstreamStatus: response.status,
          upstreamMessage: json.message
        }
      );
    }

    throw new ApiError(
      502,
      "ENDFIELD_UPSTREAM_REJECTED",
      json.message ?? "Upstream rejected request.",
      {
        upstreamCode: json.code,
        upstreamStatus: response.status,
        upstreamMessage: json.message
      }
    );
  }

  return json;
}

export async function parseAuthEnvelope<T>(response: Response): Promise<T> {
  const json = await response.json<AuthEnvelope<T>>().catch(() => null);
  if (!json) {
    throw new ApiError(502, "ENDFIELD_BAD_RESPONSE", `Failed to parse auth response (${response.status}).`);
  }

  if (!response.ok || json.status !== 0) {
    const captcha = (json.data as { captcha?: EndfieldCaptchaChallenge } | undefined)?.captcha;
    if (captcha) {
      throw new ApiError(409, "ENDFIELD_CAPTCHA_REQUIRED", json.msg ?? "Human-machine verification required.", captcha);
    }
    throw new ApiError(
      401,
      "ENDFIELD_AUTH_REJECTED",
      json.msg ?? "Auth upstream rejected request.",
      {
        upstreamStatus: response.status,
        upstreamCode: json.status,
        upstreamMessage: json.msg,
      },
    );
  }

  return json.data;
}
