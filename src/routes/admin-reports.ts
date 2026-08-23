import { Hono } from "hono";
import { requireAuth, requireRole } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { getTranslationReport } from "../repositories/report/translation-report";
import { getUgcLikeReport } from "../repositories/report/ugc-like-report";
import { getUserRegistrationReport } from "../repositories/report/user-registration-report";
import type { AppEnv } from "../types/app";

export function createAdminReportRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/registrations", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
    return c.json(await getUserRegistrationReport(c.env.DB));
  });

  app.get("/translations", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
    return c.json(await getTranslationReport(c.env.DB));
  });

  app.get("/ugc-likes", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
    return c.json(await getUgcLikeReport(c.env.DB));
  });

  return app;
}
