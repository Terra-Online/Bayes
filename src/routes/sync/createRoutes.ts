import { Hono } from "hono";

import { requireAuth } from "@/middleware/auth";
import type { AppEnv } from "@/types/app";

import { handleOfficialMarks } from "./syncHandlers";

export function createRoutes() {
  const app = new Hono<AppEnv>().use("/*", requireAuth);
  app.get("/official", handleOfficialMarks);

  return app;
}
