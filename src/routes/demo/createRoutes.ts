import { Hono } from "hono";

import { isLocalBackendUrl } from "@/lib/isLocalBackendUrl";
import type { AppEnv } from "@/types/app";

export function createRoutes() {
  const app = new Hono<AppEnv>();

  app.put("/r2", async (c) => {
    const requestUrl = new URL(c.req.url);
    if (
      !isLocalBackendUrl(c.env.BETTER_AUTH_URL) ||
      !isLocalBackendUrl(c.req.url) ||
      c.req.header("x-demo-local-sync") !== "1"
    ) {
      return c.json({ error: "not_found" }, 404);
    }
    const objectKey = requestUrl.searchParams.get("key")?.trim();
    if (!objectKey) {
      return c.json({ error: "missing_key" }, 400);
    }
    const contentType = c.req.header("content-type") ?? "application/octet-stream";
    await c.env.UGC_BUCKET.put(objectKey, await c.req.arrayBuffer(), {
      httpMetadata: { contentType },
    });
    return c.json({ ok: true, key: objectKey });
  });

  return app;
}
