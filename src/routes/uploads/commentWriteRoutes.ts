import { Hono } from "hono";

import { ApiError } from "@/lib/errors";
import { rateLimit } from "@/middleware/rate-limit";
import { commentEditSchema, commentSubmissionSchema } from "@/routes/schema/uploads";
import { flagSubmission, unflagSubmission } from "@/services/ugc/interact/flags";
import { voteComment } from "@/services/ugc/interact/votes";
import { editComment } from "@/services/ugc/owner/edits";
import { requestSubmissionRemoval } from "@/services/ugc/owner/removalRequests";
import { recallSubmission } from "@/services/ugc/owner/withdrawals";
import { submitComment } from "@/services/ugc/submission/create";
import type { AppEnv } from "@/types/app";

import { requireUserAndSubmissionId } from "./helpers";
import { requireActiveUser, requireUploadsEnabled } from "./middleware";

export function createRoutes() {
  return new Hono<AppEnv<{ requestId: string }>>()
    .post("/comments", requireActiveUser, requireUploadsEnabled, rateLimit("upload"), async (c) => {
      const user = c.get("authUser");
      if (!user) {
        throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
      }

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
        const { user, submissionId } = requireUserAndSubmissionId(c);
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
        const { user, submissionId } = requireUserAndSubmissionId(c);
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
        const { user, submissionId } = requireUserAndSubmissionId(c);
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
        const { user, submissionId } = requireUserAndSubmissionId(c);
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
        const { user, submissionId } = requireUserAndSubmissionId(c);
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
          { actor: user, submissionId, content: parsed.data.content },
        );
        return c.json({ ok: true, ...result });
      },
    )
    .post(
      "/comments/:id/remove-request",
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("auth"),
      async (c) => {
        const { user, submissionId } = requireUserAndSubmissionId(c);
        const result = await requestSubmissionRemoval(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          { actor: user, submissionId, kind: "comment" },
        );
        return c.json({ ok: true, ...result });
      },
    )
    .post(
      "/comments/:id/recall",
      requireActiveUser,
      requireUploadsEnabled,
      rateLimit("auth"),
      async (c) => {
        const { user, submissionId } = requireUserAndSubmissionId(c);
        const result = await recallSubmission(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          { actor: user, submissionId, kind: "comment" },
        );
        return c.json({ ok: true, ...result });
      },
    );
}
