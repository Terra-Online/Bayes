import { createMiddleware } from "hono/factory";

import { createToken } from "@/lib/crypto";
import type { AppEnv } from "@/types/app";

export const requestIdMiddleware = createMiddleware<AppEnv<{ requestId: string }>>(
  async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? createToken(12);
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    await next();
  },
);
