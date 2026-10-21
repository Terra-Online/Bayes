import type { Context } from "hono";

import { ApiError } from "@/lib/errors";
import { getPublicCommentContextById } from "@/repositories/submission/getPublicComment";
import { commentQuerySchema } from "@/routes/schema/uploads";
import type { AppEnv } from "@/types/app";

import { getOptionalAuthIdentity } from "./helpers";

export async function handleGetPublicComment<E extends AppEnv>(c: Context<E, "/comments/:id">) {
  const parsed = commentQuerySchema.safeParse({
    markerId: c.req.query("markerId"),
  });
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid comment query.", parsed.error.flatten());
  }

  const identity = await getOptionalAuthIdentity(c.env, c.req.raw.headers);
  const item = await getPublicCommentContextById(c.env.DB, {
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
}
