import { Hono } from "hono";
import type { z } from "zod";

import { ApiError } from "@/lib/errors";
import { requireAuth } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import { getBinding } from "@/repositories/binding/repository";
import { operation, sessionSecurity } from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/binding";
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
    .get(
      "/endfield/status",
      operation("getBindingStatus", "Binding", "Read official account binding", {
        errors: [429, 503],
        security: sessionSecurity,
        response: docs.bindingResponseSchema,
      }),
      async (c): Promise<Response> => {
        const user = c.get("authUser");
        const binding = await getBinding(c.env.DB, user.uid);
        return c.json({ binding: publicBinding(binding) } satisfies z.output<
          typeof docs.bindingResponseSchema
        >);
      },
    )
    .post(
      "/endfield/exchange-token",
      operation("exchangeBindingToken", "Binding", "Begin binding with an account token", {
        errors: [409, 429, 502, 503],
        security: sessionSecurity,
        body: docs.exchangeTokenSchema,
        response: docs.bindingExchangeResponseSchema,
      }),
      async (c): Promise<Response> => {
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
          return c.json(result satisfies z.output<typeof docs.bindingExchangeResponseSchema>);
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
      },
    )
    .post(
      "/endfield/exchange-code",
      operation("exchangeBindingCode", "Binding", "Begin binding with an authorization code", {
        errors: [429, 502, 503],
        security: sessionSecurity,
        body: docs.exchangeCodeSchema,
        response: docs.bindingExchangeResponseSchema,
      }),
      async (c): Promise<Response> => {
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
        return c.json(result satisfies z.output<typeof docs.bindingExchangeResponseSchema>);
      },
    )
    .post(
      "/endfield/bind-role",
      operation("bindOfficialRole", "Binding", "Select and bind an official role", {
        errors: [409, 429, 503],
        security: sessionSecurity,
        body: docs.bindRoleSchema,
        response: docs.bindingMutationResponseSchema,
      }),
      async (c): Promise<Response> => {
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
        return c.json({ ok: true, binding: publicBinding(binding) } satisfies z.output<
          typeof docs.bindingMutationResponseSchema
        >);
      },
    )
    .post(
      "/endfield/disable",
      operation("disableBinding", "Binding", "Disable official binding", {
        errors: [429, 503],
        security: sessionSecurity,
        response: docs.bindingMutationResponseSchema,
      }),
      async (c): Promise<Response> => {
        const user = c.get("authUser");
        const binding = await disableBinding({ uid: user.uid }, c.env);
        return c.json({ ok: true, binding: publicBinding(binding) } satisfies z.output<
          typeof docs.bindingMutationResponseSchema
        >);
      },
    )
    .post(
      "/endfield/unlink",
      operation("unlinkBinding", "Binding", "Unlink official binding", {
        errors: [429, 503],
        security: sessionSecurity,
        response: docs.bindingMutationResponseSchema,
      }),
      async (c): Promise<Response> => {
        const user = c.get("authUser");
        await unlinkBinding({ uid: user.uid }, c.env);
        return c.json({ ok: true, binding: publicBinding(null) } satisfies z.output<
          typeof docs.bindingMutationResponseSchema
        >);
      },
    );
}
