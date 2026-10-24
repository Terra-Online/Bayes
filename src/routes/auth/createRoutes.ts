import { Hono } from "hono";

import { getLegacyCookieExpirations } from "@/lib/auth/browserSession";
import { createAuth } from "@/lib/auth/createAuth";
import { invalidateAuthUserCache } from "@/lib/auth/identity";
import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import type { AppEnv } from "@/types/app";

import { forwardToAuthRawRequest } from "./forwarding";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post("/sign-out", rateLimit("public"), async (c) => {
      const response = await forwardToAuthRawRequest(c);
      if (response.ok) {
        invalidateAuthUserCache(c.req.raw.headers, c.env);
        for (const cookie of getLegacyCookieExpirations(createAuth(c.env))) {
          response.headers.append("Set-Cookie", cookie);
        }
      }
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    })
    .on(["GET", "POST", "OPTIONS"], "/*", async () => {
      throw new ApiError(404, "NOT_FOUND", "Not found.");
    });
}
