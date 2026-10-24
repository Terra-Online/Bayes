import { Hono } from "hono";

import { ApiError } from "@/lib/errors";
import { requireAuth } from "@/middleware/auth";
import { agreeSchema } from "@/routes/schema/locator";
import { preparePositionPolicy, authorizePositionPolicy } from "@/services/official/locator/policy";
import type { AppEnv } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .use("/*", requireAuth)
    .post("/agree-policy", async (c) => {
      const user = c.get("authUser");
      // Prepare before payload validation to preserve binding-error precedence;
      // authorization below uses the same binding snapshot.
      const binding = await preparePositionPolicy({ uid: user.uid }, c.env);

      const payload = await c.req.json().catch(() => undefined);
      const parsed = agreeSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid agree-policy payload.",
          parsed.error.flatten(),
        );
      }

      const result = await authorizePositionPolicy({ binding, target: parsed.data }, c.env);
      return c.json({ ok: true, binding: result });
    });
}
