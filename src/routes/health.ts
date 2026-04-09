import { Hono } from "hono";
import type { AppEnv } from "../types/app";

export function createHealthRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/status", (c) => {
    return c.json({
      status: "ok",
      service: "bayes-backend",
      now: new Date().toISOString(),
      requestId: c.get("requestId")
    });
  });

  return app;
}
