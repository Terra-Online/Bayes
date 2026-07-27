import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth";
import type { AppEnv } from "../../types/app";
import { handleAgree } from "./bindingHandlers";
import { handleEndfieldPosition, handleEndfieldPositionSocket } from "./positionHandlers";

export function createLocatorRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/position-stream", handleEndfieldPositionSocket);
  app.get("/position", handleEndfieldPosition);
  app.use("/*", requireAuth);
  app.post("/agree-policy", handleAgree);

  return app;
}
