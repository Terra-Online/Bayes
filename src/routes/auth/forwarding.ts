import { createAuth } from "../../lib/auth/createAuth";
import type { AuthRouteContext } from "./types";

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
];

const FORWARDED_HEADER_ALLOWLIST = [
  "authorization",
  "cookie",
  "user-agent",
  "accept",
  "accept-language",
  "content-type",
  "cf-connecting-ip",
  "x-request-id",
  "x-oem-locale",
  "origin",
  "referer",
];

function buildForwardHeaders(
  source: Headers,
  options?: { forceJson?: boolean; headers?: Record<string, string> }
): Headers {
  const forwardedHeaders = new Headers();

  for (const headerName of FORWARDED_HEADER_ALLOWLIST) {
    const value = source.get(headerName);
    if (value) {
      forwardedHeaders.set(headerName, value);
    }
  }

  if (options?.forceJson) {
    forwardedHeaders.set("content-type", "application/json");
    forwardedHeaders.set("accept", "application/json");
  }

  if (options?.headers) {
    for (const [name, value] of Object.entries(options.headers)) {
      forwardedHeaders.set(name, value);
    }
  }

  for (const headerName of HOP_BY_HOP_HEADERS) {
    forwardedHeaders.delete(headerName);
  }

  return forwardedHeaders;
}

export function forwardToAuthJsonPath(
  c: AuthRouteContext,
  path: string,
  body: Record<string, unknown>,
  options?: { headers?: Record<string, string> }
) {
  const auth = createAuth(c.env);
  const targetUrl = new URL(c.req.url);
  targetUrl.pathname = `/auth/v1${path}`;

  const forwardedHeaders = buildForwardHeaders(c.req.raw.headers, {
    forceJson: true,
    headers: options?.headers,
  });

  const request = new Request(targetUrl.toString(), {
    method: "POST",
    headers: forwardedHeaders,
    body: JSON.stringify(body),
  });

  return auth.handler(request);
}

export function forwardToAuthRawRequest(c: AuthRouteContext) {
  const auth = createAuth(c.env);
  const targetUrl = new URL(c.req.url);
  const method = c.req.method.toUpperCase();
  const hasRequestBody = !["GET", "HEAD"].includes(method);

  const forwardedHeaders = buildForwardHeaders(c.req.raw.headers);

  const request = new Request(targetUrl.toString(), {
    method,
    headers: forwardedHeaders,
    body: hasRequestBody ? c.req.raw.body : undefined,
  });

  return auth.handler(request);
}
