import { Hono } from "hono";

import { ApiError } from "@/lib/errors";
import { requireAuth } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import { getBinding } from "@/repositories/binding/repository";
import { bindRoleSchema, exchangeCodeSchema, exchangeTokenSchema } from "@/routes/schema/binding";
import {
  exchangeBindingToken,
  exchangeBindingCode,
  bindRole,
  disableBinding,
  unlinkBinding,
} from "@/services/official/auth/binding";
import { publicBinding } from "@/services/official/auth/publicBinding";
import type { AppEnv } from "@/types/app";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .use("/endfield/*", requireAuth, rateLimit("binding"))
    .get("/endfield/status", async (c): Promise<Response> => {
      const user = c.get("authUser");
      const binding = await getBinding(c.env.DB, user.uid);
      return c.json({ binding: publicBinding(binding) });
    })
    .post("/endfield/exchange-token", async (c): Promise<Response> => {
      const user = c.get("authUser");
      const payload = await c.req.json().catch(() => undefined);
      const parsed = exchangeTokenSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid exchange payload.",
          parsed.error.flatten(),
        );
      }

      try {
        const result = await exchangeBindingToken(
          { uid: user.uid, ...parsed.data, userAgent: c.req.header("user-agent") },
          c.env,
        );
        return c.json(result);
      } catch (error) {
        if (error instanceof ApiError) {
          console.warn("[binding][endfield][exchange-token] failed", {
            requestId: c.get("requestId"),
            provider: parsed.data.provider,
            code: error.code,
            status: error.status,
            details: error.details,
          });
        }
        throw error;
      }
    })
    .post("/endfield/exchange-code", async (c): Promise<Response> => {
      const user = c.get("authUser");
      const parsed = exchangeCodeSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid exchange payload.",
          parsed.error.flatten(),
        );
      }

      const result = await exchangeBindingCode(
        { uid: user.uid, ...parsed.data, userAgent: c.req.header("user-agent") },
        c.env,
      );
      return c.json(result);
    })
    .post("/endfield/bind-role", async (c): Promise<Response> => {
      const user = c.get("authUser");
      const parsed = bindRoleSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid role payload.",
          parsed.error.flatten(),
        );
      }

      const binding = await bindRole({ uid: user.uid, ...parsed.data }, c.env);
      return c.json({ ok: true, binding: publicBinding(binding) });
    })
    .post("/endfield/disable", async (c): Promise<Response> => {
      const user = c.get("authUser");
      const binding = await disableBinding({ uid: user.uid }, c.env);
      return c.json({ ok: true, binding: publicBinding(binding) });
    })
    .post("/endfield/unlink", async (c): Promise<Response> => {
      const user = c.get("authUser");
      await unlinkBinding({ uid: user.uid }, c.env);
      return c.json({ ok: true, binding: publicBinding(null) });
    });
}
