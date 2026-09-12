import { Hono, type MiddlewareHandler } from "hono";
import { ApiError } from "../lib/errors";
import { resolveContextAuthUser } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { translateVisibleComments } from "../services/upload/commentTranslation";
import {
  handleEditComment,
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
import { handleGetPublicComment } from "../services/upload/getPublicComment";
import { handleGetPublicImage } from "../services/upload/getPublicImage";
import { handleServePrivateImageFile, handleServePublicImageFile } from "../services/upload/serveImageFile";
import { commentTranslationSchema } from "../services/upload/schemas";
import { handleSubmitComment } from "../services/upload/submitComment";
import { handleSubmitImage } from "../services/upload/submitImage";
import type { AppEnv } from "../types/app";

function isUploadsLocked(flag: string | undefined): boolean {
  const normalized = (flag ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

async function assertActiveUser(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Promise<void> {
  const user = await resolveContextAuthUser(c);
  if (user.role === "s") {
    throw new ApiError(
      403,
      "ACCESS_DENIED",
      "Suspended users cannot access upload endpoints."
    );
  }
}

const requireActiveUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  await assertActiveUser(c);
  await next();
};

const requireUploadsEnabled: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isUploadsLocked(c.env.LOCK_UPLOAD_ENDPOINTS)) {
    throw new ApiError(
      503,
      "UPLOADS_TEMPORARILY_DISABLED",
      "Upload endpoints are temporarily disabled during stabilization."
    );
  }
  await next();
};

export function createUploadRoutes() {
  const app = new Hono<AppEnv>();

  app.post("/images", requireActiveUser, requireUploadsEnabled, rateLimit("upload"), handleSubmitImage);
  app.post("/comments", requireActiveUser, requireUploadsEnabled, rateLimit("upload"), handleSubmitComment);
  app.post("/comments/translations", rateLimit("public"), async (c) => {
    const parsed = commentTranslationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid translation payload.", parsed.error.flatten());
    }

    if (parsed.data.cachedOnly !== true) {
      await assertActiveUser(c);
    }

    return c.json(await translateVisibleComments(c.env, parsed.data));
  });

  app.get("/comments/mine", requireActiveUser, rateLimit("auth"), handleListMyComments);
  app.get("/comments", rateLimit("public"), handleListPublicComments);
  // Keep after /comments/mine so "mine" is not treated as a comment ID.
  app.get("/comments/:id", rateLimit("public"), handleGetPublicComment);
  app.post("/comments/:id/upvote", requireActiveUser, requireUploadsEnabled, rateLimit("auth"), (c) => handleCommentVote(c, 1));
  app.post("/comments/:id/downvote", requireActiveUser, requireUploadsEnabled, rateLimit("auth"), (c) => handleCommentVote(c, -1));
  app.post("/comments/:id/flag", requireActiveUser, requireUploadsEnabled, rateLimit("auth"), handleFlagComment);
  app.post("/comments/:id/unflag", requireActiveUser, requireUploadsEnabled, rateLimit("auth"), handleUnflagComment);
  app.post("/comments/:id/edit", requireActiveUser, requireUploadsEnabled, rateLimit("upload"), handleEditComment);
  app.post("/comments/:id/remove-request", requireActiveUser, requireUploadsEnabled, rateLimit("auth"), handleCommentRemoveRequest);
  app.post("/comments/:id/recall", requireActiveUser, requireUploadsEnabled, rateLimit("auth"), handleRecallComment);

  app.get("/public-file/*", rateLimit("public"), handleServePublicImageFile);
  app.get("/images/mine", requireActiveUser, rateLimit("auth"), handleListMyImages);
  // Keep after /images/mine so "mine" is not treated as an image ID.
  app.get("/images/:id", rateLimit("public"), handleGetPublicImage);
  app.get("/file/*", requireActiveUser, rateLimit("auth"), handleServePrivateImageFile);
  app.post("/images/:id/upvote", requireActiveUser, requireUploadsEnabled, rateLimit("auth"), handleImageUpvote);
  app.post("/images/:id/unvote", requireActiveUser, requireUploadsEnabled, rateLimit("auth"), handleImageUnvote);
  app.post("/images/:id/flag", requireActiveUser, requireUploadsEnabled, rateLimit("auth"), handleFlagImage);
  app.post("/images/:id/unflag", requireActiveUser, requireUploadsEnabled, rateLimit("auth"), handleUnflagImage);
  app.post("/images/:id/remove-request", requireActiveUser, requireUploadsEnabled, rateLimit("auth"), handleImageRemoveRequest);
  app.post("/images/:id/unrecall", requireActiveUser, requireUploadsEnabled, rateLimit("auth"), handleUnrecallImage);
  app.post("/images/:id/recall", requireActiveUser, requireUploadsEnabled, rateLimit("auth"), handleRecallImage);
  app.get("/images", rateLimit("public"), handleListPublicImages);

  return app;
}
