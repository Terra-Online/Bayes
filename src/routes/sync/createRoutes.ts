import { Hono } from "hono";

import { requireAuth } from "@/middleware/auth";
import { readOfficialMarks } from "@/services/official/officialMarks";
import type { AppEnv } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv>().use("/*", requireAuth).get("/official", async (c) => {
    const user = c.get("authUser");
    const result = await readOfficialMarks({ uid: user.uid }, c.env);
    c.header("cache-control", "private, no-store");
    return c.json(result);
  });
}
