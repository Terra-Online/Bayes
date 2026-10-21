import type { Hono } from "hono";

import type { AppEnv } from "@/types/app";

import { createRoutes as createAdminReportsRoutes } from "./admin-reports/createRoutes";
import { createRoutes as createAuthRoutes } from "./auth/createRoutes";
import { createRoutes as createBindingRoutes } from "./binding/createRoutes";
import { createRoutes as createDemoRoutes } from "./demo/createRoutes";
import { createRoutes as createHealthRoutes } from "./health/createRoutes";
import { createRoutes as createLocatorRoutes } from "./locator/createRoutes";
import { createRoutes as createMeRoutes } from "./me/createRoutes";
import { createRoutes as createModerationRoutes } from "./moderation/createRoutes";
import { createRoutes as createNotifyRoutes } from "./notify/createRoutes";
import { createRoutes as createProgressRoutes } from "./progress/createRoutes";
import { createRoutes as createRootRoutes } from "./root/createRoutes";
import { createRoutes as createSyncRoutes } from "./sync/createRoutes";
import { createRoutes as createUploadsRoutes } from "./uploads/createRoutes";

export function mountRoutes(app: Hono<AppEnv>): void {
  // @waf-ignore: local/demo-only helper; keep this path out of the production allowlist.
  app.route("/__demo", createDemoRoutes());
  app.route("/health/v1", createHealthRoutes());
  app.route("/admin/v1/reports", createAdminReportsRoutes());
  app.route("/auth/v1", createAuthRoutes());
  app.route("/binding/v1", createBindingRoutes());
  app.route("/locator", createLocatorRoutes());
  app.route("/progress/v1", createProgressRoutes());
  app.route("/sync/v1", createSyncRoutes());
  app.route("/uploads/v1", createUploadsRoutes());
  app.route("/moderation/v1", createModerationRoutes());
  app.route("/notify/v1", createNotifyRoutes());
  app.route("/me/v1", createMeRoutes());
  app.route("/", createRootRoutes());
}
