import { Hono } from "hono";

import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
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
    .post("/comments", requireActiveUser, requireUploadsEnabled, rateLimit("upload"), async (c) => {
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
      return c.json({ ok: true, ...result });
    })
    .post(
      "/comments/:id/upvote",
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
        return c.json({ ok: true, ...result });
      },
    )
    .post(
      "/comments/:id/downvote",
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
        return c.json({ ok: true, ...result });
      },
    )
    .post(
      "/comments/:id/flag",
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
        return c.json({ ok: true, ...result });
      },
    )
    .post(
      "/comments/:id/unflag",
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
        return c.json({ ok: true, ...result });
      },
    )
    .post(
      "/comments/:id/edit",
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
        return c.json({ ok: true, ...result });
      },
    )
    .delete(
      "/comments/:id",
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("auth"),
      async (c) => {
        const result = await deleteSubmissionByAuthor(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          { actor: c.get("authUser"), submissionId: c.req.param("id"), kind: "comment" },
        );
        return c.json({ ok: true, ...result });
      },
    );
}
