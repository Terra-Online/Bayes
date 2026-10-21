import { Hono } from "hono";

import type { AppEnv } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv>().get("/", (c) =>
    c.json({ status: "ok", message: "OEM backend is running." }),
  );
}
