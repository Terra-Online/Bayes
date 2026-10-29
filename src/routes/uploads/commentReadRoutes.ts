import { Hono } from "hono";

import { getUgcReadConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import { readPublicCommentsFromWorkersCache } from "@/publicRead/client/client";
import { resolvePublicCommentCacheNamespace } from "@/publicRead/client/scope";
import { listUserCommentsByMarker } from "@/repositories/submission/listComments";
import { commentQuerySchema, commentsQuerySchema } from "@/routes/schema/uploads";
import { readCommentContext, readCommentViewerFeed } from "@/services/ugc/read/feeds";
import type { AppEnv } from "@/types/app";

import { getOptionalAuthIdentity, hasAuthHeaders, requireMarkerIds } from "./helpers";
import { requireActiveUser } from "./middleware";
import { publicReadResponse, viewerReadResponse } from "./responses";
import { resolveImageScope } from "./scope";

export function createRoutes() {
  return (
    new Hono<AppEnv<{ requestId: string }>>()
      .get("/comments/mine", requireActiveUser, rateLimit("auth"), async (c) => {
        const user = c.get("authUser");

        const parsed = commentsQuerySchema.safeParse({
          markerId: c.req.query("markerId"),
          markerIds: c.req.query("markerIds"),
          scope: c.req.query("scope"),
          limit: c.req.query("limit"),
          replyLimit: c.req.query("replyLimit"),
          publicOnly: c.req.query("publicOnly") === "1" ? "1" : undefined,
        });
        if (!parsed.success) {
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "Invalid comment query.",
            parsed.error.flatten(),
          );
        }

        const ids = requireMarkerIds(parsed.data);
        const items = await listUserCommentsByMarker(c.env.DB, {
          userId: user.uid,
          markerIds: ids,
          limit: parsed.data.limit ?? 50,
        });

        const response = c.json({ items });
        response.headers.set("Cache-Control", "private, no-store");
        return response;
      })
      .get("/comments", rateLimit("public"), async (c) => {
        const parsed = commentsQuerySchema.safeParse({
          markerId: c.req.query("markerId"),
          markerIds: c.req.query("markerIds"),
          scope: c.req.query("scope"),
          limit: c.req.query("limit"),
          replyLimit: c.req.query("replyLimit"),
          publicOnly: c.req.query("publicOnly") === "1" ? "1" : undefined,
        });
        if (!parsed.success) {
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "Invalid comment query.",
            parsed.error.flatten(),
          );
        }

        const ids = requireMarkerIds(parsed.data);
        const limit = parsed.data.limit ?? 20;
        const replyLimit = parsed.data.replyLimit ?? 3;
        const cacheNamespace = resolvePublicCommentCacheNamespace(
          resolveImageScope(
            c.req.raw,
            getUgcReadConfig(c.env).ugcUploadPathPrefix,
            parsed.data.scope,
          ),
        );
        const publicResponsePromise = readPublicCommentsFromWorkersCache({
          markerIds: ids,
          limit,
          replyLimit,
          cacheNamespace,
        });

        if (parsed.data.publicOnly === "1" || !hasAuthHeaders(c.req.raw.headers)) {
          return publicReadResponse(await publicResponsePromise);
        }

        const [publicResponse, identity] = await Promise.all([
          publicResponsePromise,
          getOptionalAuthIdentity(c.env, c.req.raw.headers),
        ]);
        if (!identity || !publicResponse.ok) {
          return publicReadResponse(publicResponse);
        }

        const { payload } = publicResponse;
        const items = await readCommentViewerFeed(c.env.DB, {
          markerIds: ids,
          viewerUserId: identity.uid,
          publicComments: payload.items,
        });

        return viewerReadResponse(publicResponse, items);
      })
      // Keep after /comments/mine so "mine" is not treated as a comment ID.
      .get("/comments/:id", rateLimit("public"), async (c) => {
        const parsed = commentQuerySchema.safeParse({
          markerId: c.req.query("markerId"),
        });
        if (!parsed.success) {
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "Invalid comment query.",
            parsed.error.flatten(),
          );
        }

        const identity = await getOptionalAuthIdentity(c.env, c.req.raw.headers);
        const item = await readCommentContext(c.env.DB, {
          id: c.req.param("id"),
          markerId: parsed.data.markerId,
          ...(identity ? { viewerUserId: identity.uid } : {}),
        });
        if (!item) {
          throw new ApiError(404, "COMMENT_NOT_FOUND", "Comment not found.");
        }

        const response = c.json({ item });
        response.headers.set("Cache-Control", "private, no-store");
        return response;
      })
  );
}
