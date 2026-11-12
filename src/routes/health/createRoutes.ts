import { Hono } from "hono";
import { z } from "zod";

import { operation } from "@/routes/openapi/operation";
import type { AppEnv } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>().get(
    "/status",
    operation("getHealthStatus", "Health", "Read service liveness", {
      response: z.object({
        status: z.literal("ok"),
        service: z.string(),
        now: z.string(),
        requestId: z.string(),
      }),
      description: "Liveness only; does not probe storage or providers.",
    }),
    (c) => {
      return c.json({
        status: "ok",
        service: "oem-backend",
        now: new Date().toISOString(),
        requestId: c.get("requestId"),
      });
    },
  );
}
