import { Hono } from "hono";
import { z } from "zod";

import { operation } from "@/routes/openapi/operation";
import type { AppEnv } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv>().get(
    "/",
    operation("getRoot", "Health", "Read the running message", {
      response: z.object({ status: z.literal("ok"), message: z.string() }),
    }),
    (c) => c.json({ status: "ok", message: "OEM backend is running." }),
  );
}
