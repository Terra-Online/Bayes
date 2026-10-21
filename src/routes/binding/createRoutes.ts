import { Hono } from "hono";

import { ApiError } from "@/lib/errors";
import { createRedisClient } from "@/lib/redis";
import { requireAuth } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import { getBinding, publicBinding } from "@/repositories/binding/repository";
import { bindRoleSchema, exchangeCodeSchema, exchangeTokenSchema } from "@/routes/schema/binding";
import {
  exchangeBindingToken,
  exchangeBindingCode,
  bindRole,
  disableBinding,
  unlinkBinding,
  type BindingDependencies,
} from "@/services/binding/binding";
import { getPendingKey } from "@/services/binding/pendingSession";
import { deleteLocatorCaches } from "@/services/locator/cache";
import type { AppEnv } from "@/types/app";

import { getCredentialSecret } from "./credentials";
import { requireUser } from "./helpers";
import type { AppContext } from "./types";

function bindingDependencies(c: AppContext): BindingDependencies {
  return {
    db: c.env.DB,
    pending: {
      redis: () => createRedisClient(c.env),
      key: (uid, flowId) => getPendingKey(c.env, uid, flowId),
    },
    credentialSecret: () => getCredentialSecret(c),
    invalidateCaches: (uid) => deleteLocatorCaches(c.env, uid),
  };
}

async function handleBindingStatus(c: AppContext): Promise<Response> {
  const user = requireUser(c);
  const binding = await getBinding(c.env.DB, user.uid);
  return c.json({ binding: publicBinding(binding) });
}

async function handleExchangeToken(c: AppContext): Promise<Response> {
  const user = requireUser(c);
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
      bindingDependencies(c),
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
}

async function handleExchangeCode(c: AppContext): Promise<Response> {
  const user = requireUser(c);
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
    bindingDependencies(c),
  );
  return c.json(result);
}
async function handleBindRole(c: AppContext): Promise<Response> {
  const user = requireUser(c);
  const parsed = bindRoleSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid role payload.", parsed.error.flatten());
  }

  const binding = await bindRole({ uid: user.uid, ...parsed.data }, bindingDependencies(c));
  return c.json({ ok: true, binding: publicBinding(binding) });
}
async function handleDisableBinding(c: AppContext): Promise<Response> {
  const user = requireUser(c);
  const binding = await disableBinding({ uid: user.uid }, bindingDependencies(c));
  return c.json({ ok: true, binding: publicBinding(binding) });
}
async function handleUnlinkBinding(c: AppContext): Promise<Response> {
  const user = requireUser(c);
  await unlinkBinding({ uid: user.uid }, bindingDependencies(c));
  return c.json({ ok: true, binding: publicBinding(null) });
}

export function createRoutes() {
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
