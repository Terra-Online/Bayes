import { Hono } from "hono";
import { expect, it } from "vitest";

import { ApiError } from "@/lib/errors";
import type { AppEnv, AuthUser } from "@/types/app";

import { rateLimit } from "./rate-limit";

it("keeps thumbnail traffic separate from auth reads and isolates authenticated users", async () => {
  const app = new Hono<AppEnv<{ authUser?: AuthUser }>>();
  app.onError((error) => {
    if (error instanceof ApiError) {
      return new Response(error.code, { status: error.status });
    }
    throw error;
  });
  app.use("*", async (c, next) => {
    c.set("authUser", { uid: c.req.header("x-test-user"), role: "n" } as AuthUser);
    await next();
  });
  app.get("/preview", rateLimit("preview"), (c) => c.text("image"));
  app.get("/overview", rateLimit("auth"), (c) => c.text("overview"));
  const request = (path: string, user = "first") =>
    app.request(`http://localhost${path}`, { headers: { "x-test-user": user } });
  for (let i = 0; i < 300; i++) {
    expect((await request("/preview")).status).toBe(200);
  }
  expect((await request("/preview")).status).toBe(429);
  const overview = await request("/overview");
  expect(overview.status).toBe(200);
  expect(overview.headers.get("x-ratelimit-remaining")).toBe("119");
  for (let i = 1; i < 120; i++) {
    await request("/overview");
  }
  expect((await request("/overview")).status).toBe(429);
  expect((await request("/overview", "other")).status).toBe(200);
});
