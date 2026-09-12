import type { Context } from "hono";
import { ApiError } from "../../lib/errors";
import { getPublicCommentContextById } from "../../repositories/submission/getPublicComment";
import type { AppEnv } from "../../types/app";
import { commentsQuerySchema } from "./schemas";

const commentQuerySchema = commentsQuerySchema.pick({
  markerId: true
}).required({ markerId: true });

export async function handleGetPublicComment(
  c: Context<AppEnv, "/comments/:id">
) {
  const parsed = commentQuerySchema.safeParse({
    markerId: c.req.query("markerId")
  });
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid comment query.", parsed.error.flatten());
  }

  const item = await getPublicCommentContextById(c.env.DB, {
    id: c.req.param("id"),
    markerId: parsed.data.markerId
  });
  if (!item) {
    throw new ApiError(404, "COMMENT_NOT_FOUND", "Comment not found.");
  }

  const response = c.json({ item });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
