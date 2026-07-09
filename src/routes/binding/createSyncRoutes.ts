import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth";
import type { AppEnv } from "../../types/app";
import { handleOfficialMarks } from "./syncHandlers";

export function createSyncRoutes() {
  const app = new Hono<AppEnv>();

  app.use("/*", requireAuth);
  app.get("/official", handleOfficialMarks);

  return app;
}
