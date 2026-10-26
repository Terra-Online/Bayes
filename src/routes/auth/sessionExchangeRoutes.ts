import { Hono } from "hono";

import { parseTrustedFrontendOrigins } from "@/lib/auth/rules/frontendOrigins";
import { exchangeSession } from "@/lib/auth/sessionExchange";
import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import { parseInput, readJsonBody } from "@/routes/input";
import { sessionExchangeSchema } from "@/routes/schema/auth";
import type { AppEnv } from "@/types/app";

import { toSessionUser } from "./sessionUser";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>().post(
    "/session/exchange",
    rateLimit("public"),
    async (c) => {
      const origin = c.req.header("origin");
      if (!origin || !parseTrustedFrontendOrigins(c.env).includes(origin)) {
        throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "A trusted frontend origin is required.");
      }
      const input = parseInput(sessionExchangeSchema, await readJsonBody(c.req));
      const result = await exchangeSession(c.env, {
        code: input.code,
        origin,
        cookie: c.req.header("cookie"),
        userAgent: c.req.header("user-agent"),
        requestId: c.get("requestId"),
      });
      for (const cookie of result.cookies) {
        c.header("Set-Cookie", cookie, { append: true });
      }
      c.header("Cache-Control", "private, no-store");
      return c.json({ user: toSessionUser(result.user) });
    },
  );
}
