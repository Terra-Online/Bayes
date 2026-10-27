import { resolveAuthorization, type AuthCredentials } from "@/lib/auth/contract/credentials";

import { buildAuthForwardHeaders } from "./forwarding";

// The route extracts these facts from the incoming request.
export type BetterAuthRequestInfo = {
  url: string;
  method: string;
  origin?: string;
  referer?: string;
  cookie?: string;
  authorization?: string;
  clientIp?: string;
  userAgent?: string;
  accept?: string;
  contentType?: string;
  acceptedLanguages?: string;
  emailLocale?: string;
  // This is the incoming x-request-id value.
  // The application may generate a different request ID.
  requestIdHeader?: string;
};

export type BetterAuthResponseData = {
  status: number;
  // The adapter copies the body as bytes without parsing or re-encoding it.
  body: ArrayBuffer | null;
  headers: Array<[name: string, value: string]>;
  // The route emits each cookie in a separate Set-Cookie header.
  cookies: string[];
};

export function buildBetterAuthRequestHeaders(
  source: BetterAuthRequestInfo,
  options?: { forceJson?: boolean; headers?: Record<string, string> },
): Headers {
  const receivedHeaders = new Headers();
  const fields: Array<[string, string | undefined]> = [
    ["origin", source.origin],
    ["referer", source.referer],
    ["cookie", source.cookie],
    ["authorization", source.authorization],
    // Better Auth reads cf-connecting-ip for rate limits and session metadata.
    // Callers supply the client IP. This adapter sets the header.
    ["cf-connecting-ip", source.clientIp],
    ["user-agent", source.userAgent],
    ["accept", source.accept],
    ["content-type", source.contentType],
    ["accept-language", source.acceptedLanguages],
    ["x-oem-locale", source.emailLocale],
    ["x-request-id", source.requestIdHeader],
  ];
  for (const [name, value] of fields) {
    if (value) {
      receivedHeaders.set(name, value);
    }
  }
  return buildAuthForwardHeaders(receivedHeaders, options);
}

export async function readBetterAuthResponseData(
  better_auth_response: Response,
): Promise<BetterAuthResponseData> {
  const headers: BetterAuthResponseData["headers"] = [];
  better_auth_response.headers.forEach((value, name) => {
    if (name !== "set-cookie") {
      headers.push([name, value]);
    }
  });
  return {
    status: better_auth_response.status,
    body: better_auth_response.body === null ? null : await better_auth_response.arrayBuffer(),
    headers,
    cookies: better_auth_response.headers.getSetCookie(),
  };
}

export function buildSessionCredentialHeaders(credentials: AuthCredentials): Headers {
  const headers = new Headers();
  if (credentials.cookie !== undefined) {
    headers.set("cookie", credentials.cookie);
  }
  const authorization = resolveAuthorization(credentials);
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return headers;
}
