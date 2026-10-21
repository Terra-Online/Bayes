import { Hono } from "hono";

import type { AppEnv } from "@/types/app";

export function createRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => c.json({ status: "ok", message: "OEM backend is running." }));

  return app;
}
