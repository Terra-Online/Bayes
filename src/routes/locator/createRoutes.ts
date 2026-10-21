import { Hono } from "hono";

import { requireAuth } from "@/middleware/auth";
import type { AppEnv } from "@/types/app";

import { handleAgree } from "./agreePolicy";
import { handleEndfieldPosition, handleEndfieldPositionSocket } from "./positionHandlers";

export function createRoutes() {
  const app = new Hono<AppEnv<{ requestId: string }>>();

  app.get("/position-stream", handleEndfieldPositionSocket);
  app.get("/position", handleEndfieldPosition);
  const authenticated = app.use("/*", requireAuth);
  authenticated.post("/agree-policy", (c) => handleAgree(c));

  return app;
}
