import type { MiddlewareHandler } from "hono";
import { createToken } from "../lib/crypto";
import type { AppEnv } from "../types/app";

export const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? createToken(12);
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);
  await next();
};
