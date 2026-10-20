import { Hono } from "hono";
import { z } from "zod";

import { ApiError } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import {
  decodeContributionCursor,
  getContributionCounts,
  getContributionImage,
  listContributions,
} from "../repositories/me";
import type { AppEnv } from "../types/app";
import { toSessionUser } from "./auth/sessionUser";

const contributionQuerySchema = z.object({
  kind: z.enum(["image", "comment"]).optional(),
  status: z
    .enum(["pending_openai", "pending_audit", "active", "flagged", "remove_request", "stale"])
    .optional(),
  cursor: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// Completed private values are scoped to the database and user.
const readCaches = new WeakMap<D1Database, Map<string, { expiresAt: number; value: unknown }>>();
async function readCached<T>(
  db: D1Database,
  key: string,
  ttl: number,
  load: () => Promise<T>,
): Promise<T> {
  let cache = readCaches.get(db);
  if (!cache) {
    cache = new Map();
    readCaches.set(db, cache);
  }
  const found = cache.get(key);
  if (found && found.expiresAt > Date.now()) {
    return found.value as T;
  }
  const expiresAt = Date.now() + ttl;
  const value = await load();
  if ((cache.get(key)?.expiresAt ?? 0) >= expiresAt) {
    return value;
  }
  cache.delete(key);
  if (cache.size >= 256) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, { expiresAt, value });
  return value;
}

const privateHeaders = (maxAge: number) => ({
  "Cache-Control": `private, max-age=${maxAge}, must-revalidate`,
  Vary: "Cookie, Authorization",
});

export function createMeRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth);
  app.use("/overview", rateLimit("auth"));
  app.use("/contributions", rateLimit("auth"));
  app.use("/contributions/:id/preview", rateLimit("preview"));

  app.get("/overview", async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    const counts = await readCached(c.env.DB, `counts:${user.uid}`, 15_000, () =>
      getContributionCounts(c.env.DB, user.uid),
    );
    return c.json({ user: toSessionUser(user), contributions: counts }, 200, privateHeaders(15));
  });

  app.get("/contributions", async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }
    const parsed = contributionQuerySchema.safeParse({
      kind: c.req.query("kind") || undefined,
      status: c.req.query("status") || undefined,
      cursor: c.req.query("cursor") || undefined,
      limit: c.req.query("limit") || undefined,
    });
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Invalid contribution query.",
        parsed.error.flatten(),
      );
    }
    const cursor = parsed.data.cursor ? decodeContributionCursor(parsed.data.cursor) : undefined;
    if (parsed.data.cursor && !cursor) {
      throw new ApiError(422, "INVALID_CURSOR", "Contribution cursor is invalid.");
    }

    const key = JSON.stringify(["contributions", user.uid, parsed.data]);
    const result = await readCached(c.env.DB, key, 15_000, () =>
      listContributions(c.env.DB, {
        uid: user.uid,
        kind: parsed.data.kind,
        status: parsed.data.status,
        cursor: cursor ?? undefined,
        limit: parsed.data.limit,
        previewBaseUrl: "/me/v1/contributions",
      }),
    );
    return c.json(result, 200, privateHeaders(15));
  });

  app.get("/contributions/:id/preview", async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }
    const id = c.req.param("id");
    const image = await getContributionImage(c.env.DB, user.uid, id);
    if (!image) {
      throw new ApiError(404, "IMAGE_NOT_FOUND", "Image file was not found.");
    }
    const etag = c.req.header("If-None-Match");
    const object = await c.env.UGC_BUCKET.get(image.file_path, {
      onlyIf: new Headers(etag ? { "If-None-Match": etag } : {}),
    });
    if (!object) {
      throw new ApiError(404, "IMAGE_NOT_FOUND", "Image file was not found.");
    }
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set(
      "Content-Type",
      object.httpMetadata?.contentType ?? image.mime_type ?? "application/octet-stream",
    );
    Object.entries(privateHeaders(3600)).forEach(([key, value]) => headers.set(key, value));
    headers.set("etag", object.httpEtag);
    if (!("body" in object)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(object.body, { headers });
  });

  return app;
}
