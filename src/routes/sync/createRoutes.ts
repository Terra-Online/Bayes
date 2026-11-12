import { Hono } from "hono";
import type { z } from "zod";

import { requireAuth } from "@/middleware/auth";
import { operation, sessionSecurity } from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/binding";
import { readOfficialMarks } from "@/services/official/officialMarks";
import type { AppEnv } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv>().use("/*", requireAuth).get(
    "/official",
    operation("getOfficialMarks", "Official sync", "Read official marks and mapped point IDs", {
      errors: [409, 502, 503],
      security: sessionSecurity,
      response: docs.officialMarksResponseSchema,
    }),
    async (c) => {
      const user = c.get("authUser");
      const result = await readOfficialMarks({ uid: user.uid }, c.env);
      c.header("cache-control", "private, no-store");
      return c.json(result satisfies z.output<typeof docs.officialMarksResponseSchema>);
    },
  );
}
