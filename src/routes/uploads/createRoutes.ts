import { Hono, type MiddlewareHandler } from "hono";

import { ApiError } from "@/lib/errors";
import { resolveContextAuthUser } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import { commentTranslationSchema } from "@/routes/schema/uploads";
import { translateVisibleComments } from "@/services/upload/commentTranslation";
import type { AppEnv } from "@/types/app";

import { handleGetPublicComment } from "./getPublicComment";
import { handleGetPublicImage } from "./getPublicImage";
import { handleListPointImages } from "./listPointImages";
import { handleListMyComments, handleListPublicComments } from "./listPublicComments";
import { handleListMyImages, handleListPublicImages } from "./listPublicImages";
import {
  handleEditComment,
  handleCommentRemoveRequest,
  handleCommentVote,
  handleFlagComment,
  handleRecallComment,
  handleUnflagComment,
} from "./mutateComment";
import {
  handleFlagImage,
  handleImageRemoveRequest,
  handleImageUnvote,
  handleImageUpvote,
  handleRecallImage,
  handleUnflagImage,
  handleUnrecallImage,
} from "./mutateImage";
import { handleServePrivateImageFile, handleServePublicImageFile } from "./serveImageFile";
import { handleSubmitComment } from "./submitComment";
import { handleSubmitImage } from "./submitImage";

function isUploadsLocked(flag: string | undefined): boolean {
  const normalized = (flag ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

async function assertActiveUser(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Promise<void> {
  const user = await resolveContextAuthUser(c);
  if (user.role === "s") {
    throw new ApiError(403, "ACCESS_DENIED", "Suspended users cannot access upload endpoints.");
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
      "Upload endpoints are temporarily disabled during stabilization.",
    );
  }
  await next();
};

export function createRoutes() {
  const app = new Hono<AppEnv>();

  app.post(
    "/images",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("upload"),
    handleSubmitImage,
  );
  app.post(
    "/comments",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("upload"),
    handleSubmitComment,
  );
  app.post("/comments/translations", rateLimit("public"), async (c) => {
    const parsed = commentTranslationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Invalid translation payload.",
        parsed.error.flatten(),
      );
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
  app.post(
    "/comments/:id/upvote",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    (c) => handleCommentVote(c, 1),
  );
  app.post(
    "/comments/:id/downvote",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    (c) => handleCommentVote(c, -1),
  );
  app.post(
    "/comments/:id/flag",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    handleFlagComment,
  );
  app.post(
    "/comments/:id/unflag",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    handleUnflagComment,
  );
  app.post(
    "/comments/:id/edit",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("upload"),
    handleEditComment,
  );
  app.post(
    "/comments/:id/remove-request",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    handleCommentRemoveRequest,
  );
  app.post(
    "/comments/:id/recall",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    handleRecallComment,
  );

  app.get("/public-file/*", rateLimit("public"), handleServePublicImageFile);
  app.get("/images/mine", requireActiveUser, rateLimit("auth"), handleListMyImages);
  // Keep after /images/mine so "mine" is not treated as an image ID.
  app.get("/images/:id", rateLimit("public"), handleGetPublicImage);
  app.get("/file/*", requireActiveUser, rateLimit("auth"), handleServePrivateImageFile);
  app.post(
    "/images/:id/upvote",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    handleImageUpvote,
  );
  app.post(
    "/images/:id/unvote",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    handleImageUnvote,
  );
  app.post(
    "/images/:id/flag",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    handleFlagImage,
  );
  app.post(
    "/images/:id/unflag",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    handleUnflagImage,
  );
  app.post(
    "/images/:id/remove-request",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    handleImageRemoveRequest,
  );
  app.post(
    "/images/:id/unrecall",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    handleUnrecallImage,
  );
  app.post(
    "/images/:id/recall",
    requireActiveUser,
    requireUploadsEnabled,
    rateLimit("auth"),
    handleRecallImage,
  );
  const publicImageLimit = rateLimit("public");
  const privateImageLimit = rateLimit("auth");
  app.get(
    "/images",
    async (c, next) => {
      const includeMine = c.req.query("includeMine");
      if (includeMine !== undefined && includeMine !== "1") {
        throw new ApiError(422, "VALIDATION_ERROR", "includeMine must be 1 when supplied.");
      }
      if (includeMine === "1") {
        if (c.req.query("publicOnly") === "1") {
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "includeMine and publicOnly cannot be combined.",
          );
        }
        await assertActiveUser(c);
        return privateImageLimit(c, next);
      }
      return publicImageLimit(c, next);
    },
    (c) =>
      c.req.query("includeMine") === "1" ? handleListPointImages(c) : handleListPublicImages(c),
  );

  return app;
}
