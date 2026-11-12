import { Hono } from "hono";
import type { z } from "zod";

import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import { operation, sessionSecurity } from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/uploads";
import { commentEditSchema, commentSubmissionSchema } from "@/routes/schema/uploads";
import { flagSubmission, unflagSubmission } from "@/services/ugc/interact/flags";
import { voteComment } from "@/services/ugc/interact/votes";
import { deleteSubmissionByAuthor } from "@/services/ugc/owner/deletion";
import { editComment } from "@/services/ugc/owner/edits";
import { submitComment } from "@/services/ugc/submission/create";
import type { AppEnv } from "@/types/app";

import { requireActiveUser, requireUploadsEnabled } from "./middleware";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post(
      "/comments",
      operation("submitComment", "Comments", "Submit a comment for moderation", {
        errors: [404, 409, 429, 503],
        security: sessionSecurity,
        body: docs.commentSubmissionSchema,
        response: docs.commentCreatedSchema,
        description:
          "Active user and unlocked uploads required. Acceptance does not imply publication.",
      }),
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("upload"),
      async (c) => {
        const user = c.get("authUser");

        const parsed = commentSubmissionSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "Invalid comment payload.",
            parsed.error.flatten(),
          );
        }

        const result = await submitComment(c.env, { actor: user, ...parsed.data });
        return c.json({ ok: true, ...result } satisfies z.output<typeof docs.commentCreatedSchema>);
      },
    )
    .post(
      "/comments/:id/upvote",
      operation("upvoteComment", "Comments", "Upvote or toggle a comment vote", {
        errors: [404, 409, 429, 503],
        security: sessionSecurity,
        response: docs.commentVoteResponseSchema,
        description:
          "Selecting the same direction again removes the vote; selecting the opposite direction changes it. A repeated request can toggle state, so reconcile after an uncertain network outcome before retrying.",
      }),
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
        const submissionId = c.req.param("id");
        const result = await voteComment(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          { actor: user, submissionId, value: 1 },
        );
        return c.json({ ok: true, ...result } satisfies z.output<
          typeof docs.commentVoteResponseSchema
        >);
      },
    )
    .post(
      "/comments/:id/downvote",
      operation("downvoteComment", "Comments", "Downvote or toggle a comment vote", {
        errors: [404, 409, 429, 503],
        security: sessionSecurity,
        response: docs.commentVoteResponseSchema,
        description:
          "Selecting the same direction again removes the vote; selecting the opposite direction changes it. A repeated request can toggle state, so reconcile after an uncertain network outcome before retrying.",
      }),
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("auth"),
      async (c) => {
        const user = c.get("authUser");
        const submissionId = c.req.param("id");
        const result = await voteComment(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          { actor: user, submissionId, value: -1 },
        );
        return c.json({ ok: true, ...result } satisfies z.output<
          typeof docs.commentVoteResponseSchema
        >);
      },
    )
    .post(
      "/comments/:id/flag",
      operation("flagComment", "Comments", "Report a public comment", {
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
          { actor: user, submissionId, kind: "comment" },
        );
        return c.json({ ok: true, ...result } satisfies z.output<typeof docs.flagCreatedSchema>);
      },
    )
    .post(
      "/comments/:id/unflag",
      operation("unflagComment", "Comments", "Withdraw a comment report", {
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
          { actor: user, submissionId, kind: "comment" },
        );
        return c.json({ ok: true, ...result } satisfies z.output<typeof docs.flagDeletedSchema>);
      },
    )
    .post(
      "/comments/:id/edit",
      operation("editComment", "Comments", "Edit a comment", {
        errors: [404, 409, 429, 503],
        security: sessionSecurity,
        body: docs.commentEditSchema,
        response: docs.commentEditedSchema,
        description:
          "Requires ownership or administrator permission and the current approved parentSnapshotId. Existing reports are retained. COMMENT_EDIT_CONFLICT (409) means the comment changed or is no longer editable; refresh and reconcile before resubmitting.",
      }),
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("upload"),
      async (c) => {
        const user = c.get("authUser");
        const submissionId = c.req.param("id");
        const parsed = commentEditSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "Invalid comment edit payload.",
            parsed.error.flatten(),
          );
        }

        const result = await editComment(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          { actor: user, submissionId, ...parsed.data },
        );
        return c.json({ ok: true, ...result } satisfies z.output<typeof docs.commentEditedSchema>);
      },
    )
    .delete(
      "/comments/:id",
      operation("deleteComment", "Comments", "Delete an own comment from public view", {
        errors: [404, 409, 429, 503],
        security: sessionSecurity,
        response: docs.authorDeletionSchema,
        description:
          "Active user and ownership required. Content and stored versions are retained.",
      }),
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("auth"),
      async (c) => {
        const result = await deleteSubmissionByAuthor(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          { actor: c.get("authUser"), submissionId: c.req.param("id"), kind: "comment" },
        );
        return c.json({ ok: true, ...result } satisfies z.output<typeof docs.authorDeletionSchema>);
      },
    );
}
