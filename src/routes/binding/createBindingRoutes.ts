import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth";
import { rateLimit } from "../../middleware/rate-limit";
import type { AppEnv } from "../../types/app";
import {
  handleBindRole,
  handleBindingStatus,
  handleDisableBinding,
  handleExchangeCode,
  handleExchangeToken,
  handleUnlinkBinding
} from "./bindingHandlers";

export function createBindingRoutes() {
  const app = new Hono<AppEnv>();

  app.use("/endfield/*", requireAuth, rateLimit("binding"));

  app.get("/endfield/status", handleBindingStatus);
  app.post("/endfield/exchange-token", handleExchangeToken);
  app.post("/endfield/exchange-code", handleExchangeCode);
  app.post("/endfield/bind-role", handleBindRole);
  app.post("/endfield/disable", handleDisableBinding);
  app.post("/endfield/unlink", handleUnlinkBinding);

  return app;
}
