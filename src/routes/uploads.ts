import { Hono } from "hono";
import { createAuth } from "../lib/auth/createAuth";
import { ApiError } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { getUserByUid } from "../repositories/users";
import { translateVisibleComments } from "../services/upload/commentTranslation";
import {
  handleCommentRemoveRequest,
  handleCommentVote,
  handleFlagComment,
  handleRecallComment,
  handleUnflagComment
} from "../services/upload/mutateComment";
import {
  handleFlagImage,
  handleImageRemoveRequest,
  handleImageUnvote,
  handleImageUpvote,
  handleRecallImage,
  handleUnflagImage,
  handleUnrecallImage
} from "../services/upload/mutateImage";
import { handleListMyComments, handleListPublicComments } from "../services/upload/listPublicComments";
import { handleListMyImages, handleListPublicImages } from "../services/upload/listPublicImages";
import { handleServePrivateImageFile, handleServePublicImageFile } from "../services/upload/serveImageFile";
import { commentTranslationSchema } from "../services/upload/schemas";
import { handleSubmitComment } from "../services/upload/submitComment";
import { handleSubmitImage } from "../services/upload/submitImage";
import type { AppEnv } from "../types/app";

function isUploadsLocked(flag: string | undefined): boolean {
  const normalized = (flag ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

function isReadOrPublicTranslation(method: string, path: string): boolean {
  const isImageRead = method === "GET" && (
    path.endsWith("/uploads/v1/images") ||
    path.endsWith("/uploads/v1/images/mine") ||
    path.endsWith("/uploads/v1/comments") ||
    path.endsWith("/uploads/v1/comments/mine") ||
    path.includes("/uploads/v1/public-file/") ||
    path.includes("/uploads/v1/file/") ||
    path.includes("/public-file/") ||
    path.includes("/file/")
  );
  const isPublicTranslation = method === "POST" && path.endsWith("/uploads/v1/comments/translations");
  return isImageRead || isPublicTranslation;
}

export function createUploadRoutes() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const hasAuthHeaders = Boolean(
      c.req.header("authorization")?.trim() ||
      c.req.header("cookie")?.trim()
    );
    if (hasAuthHeaders) {
      const session = await createAuth(c.env).api.getSession({
        headers: c.req.raw.headers
      });
      if (session) {
        const user = await getUserByUid(c.env.DB, session.user.id);
        if (user?.role === "s") {
          throw new ApiError(
            403,
            "ACCESS_DENIED",
            "Suspended users cannot access upload endpoints."
          );
        }
      }
    }

    if (!isReadOrPublicTranslation(c.req.method, c.req.path) && isUploadsLocked(c.env.LOCK_UPLOAD_ENDPOINTS)) {
      throw new ApiError(
        503,
        "UPLOADS_TEMPORARILY_DISABLED",
        "Upload endpoints are temporarily disabled during stabilization."
      );
    }
    await next();
  });

  app.post("/images", requireAuth, rateLimit("upload"), handleSubmitImage);
  app.post("/comments", requireAuth, rateLimit("upload"), handleSubmitComment);
  app.post("/comments/translations", rateLimit("public"), async (c) => {
    const parsed = commentTranslationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid translation payload.", parsed.error.flatten());
    }

    return c.json(await translateVisibleComments(c.env, parsed.data));
  });

  app.get("/comments/mine", requireAuth, rateLimit("auth"), handleListMyComments);
  app.get("/comments", rateLimit("public"), handleListPublicComments);
  app.post("/comments/:id/upvote", requireAuth, rateLimit("auth"), (c) => handleCommentVote(c, 1));
  app.post("/comments/:id/downvote", requireAuth, rateLimit("auth"), (c) => handleCommentVote(c, -1));
  app.post("/comments/:id/flag", requireAuth, rateLimit("auth"), handleFlagComment);
  app.post("/comments/:id/unflag", requireAuth, rateLimit("auth"), handleUnflagComment);
  app.post("/comments/:id/remove-request", requireAuth, rateLimit("auth"), handleCommentRemoveRequest);
  app.post("/comments/:id/recall", requireAuth, rateLimit("auth"), handleRecallComment);

  app.get("/public-file/*", rateLimit("public"), handleServePublicImageFile);
  app.get("/images/mine", requireAuth, rateLimit("auth"), handleListMyImages);
  app.get("/file/*", requireAuth, rateLimit("auth"), handleServePrivateImageFile);
  app.post("/images/:id/upvote", requireAuth, rateLimit("auth"), handleImageUpvote);
  app.post("/images/:id/unvote", requireAuth, rateLimit("auth"), handleImageUnvote);
  app.post("/images/:id/flag", requireAuth, rateLimit("auth"), handleFlagImage);
  app.post("/images/:id/unflag", requireAuth, rateLimit("auth"), handleUnflagImage);
  app.post("/images/:id/remove-request", requireAuth, rateLimit("auth"), handleImageRemoveRequest);
  app.post("/images/:id/unrecall", requireAuth, rateLimit("auth"), handleUnrecallImage);
  app.post("/images/:id/recall", requireAuth, rateLimit("auth"), handleRecallImage);
  app.get("/images", rateLimit("public"), handleListPublicImages);

  return app;
}
