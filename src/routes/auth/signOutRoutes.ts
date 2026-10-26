import { Hono } from "hono";

import { signOut } from "@/lib/auth/signOut";
import { rateLimit } from "@/middleware/rate-limit";
import type { AppEnv } from "@/types/app";

import { authRequestInfo, authResponse } from "./honoAdapter";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>().post(
    "/sign-out",
    rateLimit("public"),
    async (c) => {
      const body = c.req.raw.body === null ? null : await c.req.arrayBuffer();
      return authResponse(
        c,
        await signOut(c.env, {
          body,
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
        }),
      );
    },
  );
}
