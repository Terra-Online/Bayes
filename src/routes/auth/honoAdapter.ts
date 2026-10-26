import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";

import type { BetterAuthRequestInfo, BetterAuthResponseData } from "@/lib/auth/betterAuth";
import type { AppEnv } from "@/types/app";

export function authRequestInfo(c: Context<AppEnv<{ requestId: string }>>): BetterAuthRequestInfo {
  return {
    url: c.req.url,
    method: c.req.method,
    origin: c.req.header("origin"),
    referer: c.req.header("referer"),
    cookie: c.req.header("cookie"),
    authorization: c.req.header("authorization"),
    clientIp: c.req.header("cf-connecting-ip"),
    userAgent: c.req.header("user-agent"),
    accept: c.req.header("accept"),
    contentType: c.req.header("content-type"),
    acceptedLanguages: c.req.header("accept-language"),
    emailLocale: c.req.header("x-oem-locale"),
    requestIdHeader: c.req.header("x-request-id"),
  };
}

export function authResponse(
  c: Context<AppEnv<{ requestId: string }>>,
  result: BetterAuthResponseData,
): Response {
  const headers = new Headers(result.headers);
  for (const cookie of result.cookies) {
    headers.append("set-cookie", cookie);
  }
  return c.newResponse(result.body, { status: result.status as StatusCode, headers });
}
