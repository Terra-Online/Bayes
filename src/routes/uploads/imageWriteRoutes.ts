import { Hono } from "hono";

import { getUgcReadConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import { imageUploadFieldsSchema } from "@/routes/schema/uploads";
import { flagSubmission, unflagSubmission } from "@/services/ugc/interact/flags";
import { unvoteImage, upvoteImage } from "@/services/ugc/interact/votes";
import {
  cancelRemoveImageRequest,
  requestSubmissionRemoval,
} from "@/services/ugc/owner/removalRequests";
import { recallSubmission } from "@/services/ugc/owner/withdrawals";
import { submitImage } from "@/services/ugc/submission/create";
import type { AppEnv } from "@/types/app";

import { pickFile, pickString } from "./helpers";
import { requireActiveUser, requireUploadsEnabled } from "./middleware";
import { resolveImageScope, resolveUploadPrefix } from "./scope";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post("/images", requireActiveUser, requireUploadsEnabled, rateLimit("upload"), async (c) => {
      const user = c.get("authUser");

      const form = await c.req.parseBody();
      const file = pickFile(form.file) ?? pickFile(form.image);
      if (!file) {
        throw new ApiError(422, "UPLOAD_FILE_MISSING", "Image file is required.");
      }

      const parsed = imageUploadFieldsSchema.safeParse({
        markerId: pickString(form.markerId),
        poiHash: pickString(form.poiHash),
        poiType: pickString(form.poiType),
        content: pickString(form.content),
      });
      if (!parsed.success) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid upload payload.",
          parsed.error.flatten(),
        );
      }

      const config = getUgcReadConfig(c.env);
      const { submission, duplicatePoi } = await submitImage(c.env, {
        actor: user,
        file,
        ...parsed.data,
        uploadPrefix: resolveUploadPrefix(c.req.raw, config.ugcUploadPathPrefix),
        scope: resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, undefined),
        signal: c.req.raw.signal,
        requestId: c.get("requestId"),
      });

      return c.json({
        ok: true,
        submission,
        duplicatePoi: duplicatePoi
          ? {
              ...duplicatePoi,
              dashboardPath: `/ugc-review?duplicateMarker=${encodeURIComponent(duplicatePoi.markerId)}`,
            }
          : null,
      });
    })
    .post(
      "/images/:id/upvote",
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
        const submissionId = c.req.param("id");
        const result = await upvoteImage(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          { actor: user, submissionId },
        );
        return c.json({ ok: true, ...result });
      },
    )
    .post(
      "/images/:id/unvote",
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
        const submissionId = c.req.param("id");
        const result = await unvoteImage(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          { actor: user, submissionId },
        );
        return c.json({ ok: true, ...result });
      },
    )
    .post(
      "/images/:id/flag",
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
        const submissionId = c.req.param("id");
        const result = await flagSubmission(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          { actor: user, submissionId, kind: "image" },
        );
        return c.json({ ok: true, ...result });
      },
    )
    .post(
      "/images/:id/unflag",
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
        const submissionId = c.req.param("id");
        const result = await unflagSubmission(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          { actor: user, submissionId, kind: "image" },
        );
        return c.json({ ok: true, ...result });
      },
    )
    .post(
      "/images/:id/remove-request",
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
        const submissionId = c.req.param("id");
        const result = await requestSubmissionRemoval(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          { actor: user, submissionId, kind: "image" },
        );
        return c.json({ ok: true, ...result });
      },
    )
    .post(
      "/images/:id/unrecall",
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
        const submissionId = c.req.param("id");
        const result = await cancelRemoveImageRequest(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          { actor: user, submissionId },
        );
        return c.json({ ok: true, ...result });
      },
    )
    .post(
      "/images/:id/recall",
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
        const submissionId = c.req.param("id");
        const result = await recallSubmission(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          { actor: user, submissionId, kind: "image" },
        );
        return c.json({ ok: true, ...result });
      },
    );
}
