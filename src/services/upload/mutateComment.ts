import { ApiError } from "../../lib/errors";
import { RECALL_MODERATION_NOTE_PREFIX } from "../../lib/moderation";
import { invalidateUploadCaches } from "../../middleware/cache/uploadCaches";
import {
  countSubmissionFlags,
  createSubmissionFlag,
  deleteSubmissionFlag,
} from "../../repositories/submission/flagSubmission";
import {
  getSubmissionById,
  updateSubmissionStatus
} from "../../repositories/submission/statusSubmission";
import {
  getSubmissionScore,
  setSubmissionVote,
} from "../../repositories/submission/voteSubmission";
import type { AppEnv } from "../../types/app";
import {
  notifyFlagCreated,
  notifyFlagRemoved,
  notifyRemoveRequestCreated
} from "../notifications";

function requireUserAndSubmissionId(c: import("hono").Context<AppEnv>) {
  const user = c.get("authUser");
  const submissionId = c.req.param("id");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }
  if (!submissionId) {
    throw new ApiError(422, "VALIDATION_ERROR", "Submission id is required.");
  }
  return { user, submissionId };
}

function invalidateCommentCache(c: import("hono").Context<AppEnv>, markerId: string): void {
  c.executionCtx.waitUntil(invalidateUploadCaches({
    kv: c.env.OEM_KV,
    kind: "comment",
    markerId
  }));
}

export async function handleCommentVote(c: import("hono").Context<AppEnv>, value: 1 | -1) {
  const { user, submissionId } = requireUserAndSubmissionId(c);
  const submission = await getSubmissionById(c.env.DB, submissionId);
  if (!submission || submission.kind !== "comment") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Comment submission was not found.");
  }
  if (!["active", "flagged", "remove_request"].includes(submission.status)) {
    throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only visible comments can be voted.", {
      status: submission.status
    });
  }

  const vote = await setSubmissionVote(c.env.DB, {
    submissionId,
    userId: user.uid,
    value
  });
  const score = await getSubmissionScore(c.env.DB, submissionId);
  invalidateCommentCache(c, submission.markerId);

  return c.json({ ok: true, vote, score });
}

export async function handleFlagComment(c: import("hono").Context<AppEnv>) {
  const { user, submissionId } = requireUserAndSubmissionId(c);
  const submission = await getSubmissionById(c.env.DB, submissionId);
  if (!submission || submission.kind !== "comment") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Comment submission was not found.");
  }
  if (submission.userId === user.uid) {
    throw new ApiError(403, "CANNOT_FLAG_OWN_SUBMISSION", "You cannot flag your own comment.");
  }
  if (submission.status !== "active" && submission.status !== "flagged") {
    throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only active or flagged comments can be flagged.", {
      status: submission.status
    });
  }

  const created = await createSubmissionFlag(c.env.DB, {
    submissionId,
    userId: user.uid
  });
  if (created && submission.status === "active") {
    await updateSubmissionStatus(c.env.DB, {
      id: submissionId,
      status: "flagged",
      moderationNote: "Flagged by user."
    });
  }
  const flagCount = await countSubmissionFlags(c.env.DB, submissionId);
  invalidateCommentCache(c, submission.markerId);
  if (created) {
    c.executionCtx.waitUntil(
      notifyFlagCreated(c.env, {
        submission,
        actor: user,
        changed: created,
        flagCount,
        nextStatus: "flagged"
      })
    );
  }

  return c.json({ ok: true, created, status: "flagged", flagCount });
}

export async function handleUnflagComment(c: import("hono").Context<AppEnv>) {
  const { user, submissionId } = requireUserAndSubmissionId(c);
  const submission = await getSubmissionById(c.env.DB, submissionId);
  if (!submission || submission.kind !== "comment") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Comment submission was not found.");
  }
  if (submission.userId === user.uid) {
    throw new ApiError(403, "CANNOT_UNFLAG_OWN_SUBMISSION", "You cannot unflag your own comment.");
  }
  if (submission.status !== "active" && submission.status !== "flagged") {
    throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only active or flagged comments can be unflagged.", {
      status: submission.status
    });
  }

  const deleted = await deleteSubmissionFlag(c.env.DB, {
    submissionId,
    userId: user.uid
  });
  const flagCount = await countSubmissionFlags(c.env.DB, submissionId);
  const status = flagCount > 0 ? "flagged" : "active";
  if (submission.status !== status) {
    await updateSubmissionStatus(c.env.DB, {
      id: submissionId,
      status,
      moderationNote: status === "active" ? "User flag removed." : undefined
    });
  }
  invalidateCommentCache(c, submission.markerId);
  if (deleted) {
    c.executionCtx.waitUntil(
      notifyFlagRemoved(c.env, {
        submission,
        actor: user,
        changed: deleted,
        flagCount,
        nextStatus: status
      })
    );
  }

  return c.json({ ok: true, deleted, status, flagCount });
}

export async function handleCommentRemoveRequest(c: import("hono").Context<AppEnv>) {
  const { user, submissionId } = requireUserAndSubmissionId(c);
  const submission = await getSubmissionById(c.env.DB, submissionId);
  if (!submission || submission.kind !== "comment") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Comment submission was not found.");
  }
  if (submission.userId !== user.uid) {
    throw new ApiError(403, "REMOVE_REQUEST_OWNER_ONLY", "Only the author can request comment removal.");
  }
  if (submission.status !== "active" && submission.status !== "flagged") {
    throw new ApiError(409, "INVALID_STATUS_TRANSITION", "Only visible comments can receive a remove request.", {
      from: submission.status,
      to: "remove_request"
    });
  }

  await updateSubmissionStatus(c.env.DB, {
    id: submissionId,
    status: "remove_request",
    moderationNote: "Removal requested by author."
  });
  invalidateCommentCache(c, submission.markerId);
  c.executionCtx.waitUntil(
    notifyRemoveRequestCreated(c.env, {
      submission,
      actor: user,
      nextStatus: "remove_request",
      source: "remove_request"
    })
  );

  return c.json({ ok: true, status: "remove_request" });
}

export async function handleRecallComment(c: import("hono").Context<AppEnv>) {
  const { user, submissionId } = requireUserAndSubmissionId(c);
  const submission = await getSubmissionById(c.env.DB, submissionId);
  if (!submission || submission.kind !== "comment") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Comment submission was not found.");
  }
  if (submission.userId !== user.uid) {
    throw new ApiError(403, "RECALL_OWNER_ONLY", "Only the author can recall a comment.");
  }
  if (submission.status === "stale") {
    return c.json({ ok: true, status: "stale" });
  }
  if (!["pending_openai", "pending_audit", "active", "flagged", "remove_request"].includes(submission.status)) {
    throw new ApiError(409, "INVALID_STATUS_TRANSITION", "Comment cannot be recalled from its current status.", {
      from: submission.status,
      to: "remove_request"
    });
  }

  if (submission.status === "pending_openai" || submission.status === "pending_audit") {
    await updateSubmissionStatus(c.env.DB, {
      id: submissionId,
      status: "stale",
      moderationNote: `${RECALL_MODERATION_NOTE_PREFIX} comment error.`
    });
    invalidateCommentCache(c, submission.markerId);
    return c.json({ ok: true, status: "stale" });
  }

  await updateSubmissionStatus(c.env.DB, {
    id: submissionId,
    status: "remove_request",
    moderationNote: `${RECALL_MODERATION_NOTE_PREFIX} comment error.`
  });
  invalidateCommentCache(c, submission.markerId);
  c.executionCtx.waitUntil(
    notifyRemoveRequestCreated(c.env, {
      submission,
      actor: user,
      nextStatus: "remove_request",
      source: "recall"
    })
  );

  return c.json({ ok: true, status: "remove_request" });
}
