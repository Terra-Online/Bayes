import { Hono } from "hono";

import { requireAuth } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import { getRequestAuthCredentials } from "@/services/auth/requestCredentials";
import { invalidateSessionCache } from "@/services/auth/session";
import { updateProfile } from "@/services/profile";
import type { AppEnv } from "@/types/app";

import { readProfileUpdateInput } from "./input";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>().patch(
    "/profile",
    requireAuth,
    rateLimit("auth"),
    async (c) => {
      const input = await readProfileUpdateInput(c.req);
      const user = await updateProfile(c.env.DB, {
        userId: c.get("authUser").uid,
        ...input,
      });
      invalidateSessionCache(c.env, getRequestAuthCredentials(c.req.raw));
      return c.json({ user });
    },
  );
}
