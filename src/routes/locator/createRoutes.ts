import { Hono } from "hono";

import { requireAuth } from "@/middleware/auth";
import type { AppEnv } from "@/types/app";

import { handleAgree } from "./agreePolicy";
import { handleEndfieldPosition, handleEndfieldPositionSocket } from "./positionHandlers";

export function createRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/position-stream", handleEndfieldPositionSocket);
  app.get("/position", handleEndfieldPosition);
  app.use("/*", requireAuth);
  app.post("/agree-policy", handleAgree);

  return app;
}
