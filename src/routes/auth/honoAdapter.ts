import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";

import type { AppEnv } from "@/types/app";

// Hono keeps middleware headers pending until newResponse merges them.
// Pass the body stream through without reading it or copying headers into a DTO.
export function authResponse<E extends AppEnv<{ requestId: string }>>(
  c: Context<E>,
  better_auth_response: Response,
): Response {
  return c.newResponse(better_auth_response.body, {
    status: better_auth_response.status as StatusCode,
    headers: better_auth_response.headers,
  });
}
