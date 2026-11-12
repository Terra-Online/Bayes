import { Hono } from "hono";
import { z } from "zod";

import { getUgcReadConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import { operation, sessionSecurity } from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/uploads";
import { imageUploadFieldsSchema } from "@/routes/schema/uploads";
import { flagSubmission, unflagSubmission } from "@/services/ugc/interact/flags";
import { unvoteImage, upvoteImage } from "@/services/ugc/interact/votes";
import { deleteSubmissionByAuthor } from "@/services/ugc/owner/deletion";
import { submitImage } from "@/services/ugc/submission/create";
import type { AppEnv } from "@/types/app";

import { pickFile, pickString } from "./helpers";
import { requireActiveUser, requireUploadsEnabled } from "./middleware";
import { resolveImageScope, resolveUploadPrefix } from "./scope";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post(
      "/images",
      operation("submitImage", "Images", "Upload an image for moderation", {
        errors: [409, 429, 503],
        security: sessionSecurity,
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  ...z.toJSONSchema(docs.imageUploadFieldsSchema).properties,
                  file: { type: "string", format: "binary" },
                },
                required: ["file", "markerId", "poiHash", "poiType"],
              },
            },
          },
        },
        response: docs.imageCreatedSchema,
        description:
          "Active user and unlocked uploads required. Let the HTTP client set the multipart boundary. Acceptance does not imply publication.",
      }),
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("upload"),
      async (c) => {
        const user = c.get("authUser");

        const form = await c.req.parseBody();
        const file = pickFile(form.file);
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
        } satisfies z.output<typeof docs.imageCreatedSchema>);
      },
    )
    .post(
      "/images/:id/upvote",
      operation("upvoteImage", "Images", "Upvote a public image", {
        errors: [404, 409, 429, 503],
        security: sessionSecurity,
        response: docs.imageVoteCreatedSchema,
      }),
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
        return c.json({ ok: true, ...result } satisfies z.output<
          typeof docs.imageVoteCreatedSchema
        >);
      },
    )
    .post(
      "/images/:id/unvote",
      operation("unvoteImage", "Images", "Withdraw an image upvote", {
        errors: [404, 409, 429, 503],
        security: sessionSecurity,
        response: docs.imageVoteDeletedSchema,
      }),
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
        return c.json({ ok: true, ...result } satisfies z.output<
          typeof docs.imageVoteDeletedSchema
        >);
      },
    )
    .post(
      "/images/:id/flag",
      operation("flagImage", "Images", "Report a public image", {
        errors: [404, 409, 429, 503],
        security: sessionSecurity,
        response: docs.flagCreatedSchema,
      }),
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
        return c.json({ ok: true, ...result } satisfies z.output<typeof docs.flagCreatedSchema>);
      },
    )
    .post(
      "/images/:id/unflag",
      operation("unflagImage", "Images", "Withdraw an image report", {
        errors: [404, 409, 429, 503],
        security: sessionSecurity,
        response: docs.flagDeletedSchema,
      }),
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
        return c.json({ ok: true, ...result } satisfies z.output<typeof docs.flagDeletedSchema>);
      },
    )
    .delete(
      "/images/:id",
      operation("deleteImage", "Images", "Delete an own image from public view", {
        errors: [404, 409, 429, 503],
        security: sessionSecurity,
        response: docs.authorDeletionSchema,
        description: "Active user and ownership required. Content and stored objects are retained.",
      }),
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("auth"),
      async (c) => {
        const result = await deleteSubmissionByAuthor(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          { actor: c.get("authUser"), submissionId: c.req.param("id"), kind: "image" },
        );
        return c.json({ ok: true, ...result } satisfies z.output<typeof docs.authorDeletionSchema>);
      },
    );
}
