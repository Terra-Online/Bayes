import { Hono } from "hono";

import { beginLinkLoginMethod, listLoginMethods, unlinkLoginMethod } from "@/lib/auth/loginMethods";
import { requireAuth } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import { parseInput } from "@/routes/input";
import { linkAccountSchema, unlinkAccountSchema } from "@/routes/schema/auth";
import type { AppEnv } from "@/types/app";

import { authRequestInfo, authResponse } from "./honoAdapter";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .get("/list-accounts", requireAuth, rateLimit("auth"), async (c) => {
      const user = c.get("authUser");

      const accounts = await listLoginMethods(c.env, { currentUserId: user.uid });
      const response = c.json({ accounts });
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    })
    .post("/link-social", requireAuth, rateLimit("auth"), async (c) => {
      const input = parseInput(
        linkAccountSchema,
        await c.req.json().catch(() => null),
        "Invalid account link payload.",
      );

      return authResponse(
        c,
        await beginLinkLoginMethod(c.env, {
          ...input,
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
        }),
      );
    })
    .post("/unlink-account", requireAuth, rateLimit("auth"), async (c) => {
      const input = parseInput(
        unlinkAccountSchema,
        await c.req.json().catch(() => null),
        "Invalid account unlink payload.",
      );

      const user = c.get("authUser");
      return authResponse(
        c,
        await unlinkLoginMethod(c.env, {
          ...input,
          currentUserId: user.uid,
          request: authRequestInfo(c),
          requestId: c.get("requestId"),
        }),
      );
    });
}
