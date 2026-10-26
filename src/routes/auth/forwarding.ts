import type { Context } from "hono";

import { buildAuthForwardHeaders, invokeBetterAuthHandler } from "@/lib/auth/betterAuth";
import type { AppEnv } from "@/types/app";

export function forwardToAuthJsonPath<E extends AppEnv<{ requestId: string }>>(
  c: Context<E>,
  path: string,
  body: Record<string, unknown>,
  options?: { headers?: Record<string, string> },
) {
  const targetUrl = new URL(c.req.url);
  targetUrl.pathname = `/auth/v1${path}`;

  const forwardedHeaders = buildAuthForwardHeaders(c.req.raw.headers, {
    forceJson: true,
    headers: options?.headers,
  });

  const request = new Request(targetUrl.toString(), {
    method: "POST",
    headers: forwardedHeaders,
    body: JSON.stringify(body),
  });

  return invokeBetterAuthHandler(c.env, request, {
    publicPath: c.req.path,
    authPath: path,
    requestId: c.get("requestId"),
  });
}

export function forwardToAuthRawRequest<E extends AppEnv<{ requestId: string }>>(c: Context<E>) {
  const targetUrl = new URL(c.req.url);
  const method = c.req.method.toUpperCase();
  const hasRequestBody = !["GET", "HEAD"].includes(method);

  const forwardedHeaders = buildAuthForwardHeaders(c.req.raw.headers);

  const request = new Request(targetUrl.toString(), {
    method,
    headers: forwardedHeaders,
    body: hasRequestBody ? c.req.raw.body : undefined,
  });

  return invokeBetterAuthHandler(c.env, request, {
    publicPath: c.req.path,
    authPath: targetUrl.pathname.replace(/^\/auth\/v1/, ""),
    requestId: c.get("requestId"),
  });
}
