import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import {
  decodeContributionCursor,
  getContributionCounts,
  listContributions,
  listLoginMethods,
} from "../repositories/me";
import { getBinding, publicBinding } from "./binding/repository";
import { toSessionUser } from "./auth/sessionUser";
import type { AppEnv } from "../types/app";

const contributionQuerySchema = z.object({
  kind: z.enum(["image", "comment"]).optional(),
  status: z.enum(["pending_openai", "pending_audit", "active", "flagged", "remove_request", "stale"]).optional(),
  cursor: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function createMeRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth, rateLimit("auth"));

  app.get("/overview", async (c) => {
    const user = c.get("authUser");
    if (!user) throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");

    const [loginMethods, binding, counts, recent] = await Promise.all([
      listLoginMethods(c.env.DB, user.uid),
      getBinding(c.env.DB, user.uid),
      getContributionCounts(c.env.DB, user.uid),
      listContributions(c.env.DB, { uid: user.uid, limit: 5 }),
    ]);

    const response = c.json({
      user: toSessionUser(user),
      loginMethods,
      services: { endfield: publicBinding(binding) },
      contributions: { ...counts, recent: recent.items },
    });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  });

  app.get("/contributions", async (c) => {
    const user = c.get("authUser");
    if (!user) throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    const parsed = contributionQuerySchema.safeParse({
      kind: c.req.query("kind") || undefined,
      status: c.req.query("status") || undefined,
      cursor: c.req.query("cursor") || undefined,
      limit: c.req.query("limit") || undefined,
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid contribution query.", parsed.error.flatten());
    }
    const cursor = parsed.data.cursor ? decodeContributionCursor(parsed.data.cursor) : undefined;
    if (parsed.data.cursor && !cursor) {
      throw new ApiError(422, "INVALID_CURSOR", "Contribution cursor is invalid.");
    }

    const result = await listContributions(c.env.DB, {
      uid: user.uid,
      kind: parsed.data.kind,
      status: parsed.data.status,
      cursor: cursor ?? undefined,
      limit: parsed.data.limit,
    });
    const response = c.json(result);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  });

  return app;
}
