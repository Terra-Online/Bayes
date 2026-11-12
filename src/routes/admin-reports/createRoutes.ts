import { Hono } from "hono";
import type { z } from "zod";

import { requireAuth, requireRole } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import { getTranslationReport } from "@/repositories/report/translation-report";
import { getUgcLikeReport } from "@/repositories/report/ugc-like-report";
import { getUserRegistrationReport } from "@/repositories/report/user-registration-report";
import { operation, sessionSecurity } from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/reports";
import type { AppEnv } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv>()
    .get(
      "/registrations",
      operation("getRegistrationReport", "Administrative reports", "Read registration statistics", {
        errors: [429, 503],
        security: sessionSecurity,
        response: docs.registrationReportSchema,
        description: "Administrator role required.",
      }),
      requireAuth,
      requireRole(["a"]),
      rateLimit("auth"),
      async (c) => {
        return c.json(
          (await getUserRegistrationReport(c.env.DB)) satisfies z.output<
            typeof docs.registrationReportSchema
          >,
        );
      },
    )
    .get(
      "/translations",
      operation("getTranslationReport", "Administrative reports", "Read translation statistics", {
        errors: [429, 503],
        security: sessionSecurity,
        response: docs.translationReportSchema,
        description: "Administrator role required.",
      }),
      requireAuth,
      requireRole(["a"]),
      rateLimit("auth"),
      async (c) => {
        return c.json(
          (await getTranslationReport(c.env.DB)) satisfies z.output<
            typeof docs.translationReportSchema
          >,
        );
      },
    )
    .get(
      "/ugc-likes",
      operation(
        "getUgcLikeReport",
        "Administrative reports",
        "Read contribution reaction statistics",
        {
          errors: [429, 503],
          security: sessionSecurity,
          response: docs.ugcLikeReportSchema,
          description: "Administrator role required.",
        },
      ),
      requireAuth,
      requireRole(["a"]),
      rateLimit("auth"),
      async (c) => {
        return c.json(
          (await getUgcLikeReport(c.env.DB)) satisfies z.output<typeof docs.ugcLikeReportSchema>,
        );
      },
    );
}
