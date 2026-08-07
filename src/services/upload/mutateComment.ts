import { nanoid } from "nanoid";
import { ApiError } from "../../lib/errors";
import {
  COMMENT_ADMIN_EDIT_MODERATION_NOTE_PREFIX,
  COMMENT_EDIT_MODERATION_NOTE_PREFIX,
  RECALL_MODERATION_NOTE_PREFIX
} from "../../lib/moderation";
import { invalidateUploadCaches } from "../../middleware/cache/uploadCaches";
import {
  countSubmissionFlags,
  clearSubmissionFlags,
  createSubmissionFlag,
  deleteSubmissionFlag,
} from "../../repositories/submission/flagSubmission";
import {
  getSubmissionById,
  revertCommentEdit,
  transitionSubmissionStatusWithNotifications,
  updateCommentContentForModeration,
  updateSubmissionStatus,
} from "../../repositories/submission/statusSubmission";
import {
  getSubmissionScore,
  setSubmissionVote,
} from "../../repositories/submission/voteSubmission";
import type { AppEnv } from "../../types/app";
import { enqueueModeration } from "../moderation/queue";
import {
  notifyFlagCreated,
  notifyFlagRemoved,
  notifyRemoveRequestCreated
} from "../moderation/notifications";
import { publishNotificationsCreated } from "../notify/live";
import { commentEditSchema } from "./schemas";

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
    actor: user,
    value
  });
  const score = await getSubmissionScore(c.env.DB, submissionId);
  invalidateCommentCache(c, submission.markerId);
  if (vote.notifications.length > 0) {
    c.executionCtx.waitUntil(publishNotificationsCreated(c.env, vote.notifications));
  }

  return c.json({ ok: true, vote: vote.currentVote, previousVote: vote.previousVote, score });
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

export async function handleEditComment(c: import("hono").Context<AppEnv>) {
  const { user, submissionId } = requireUserAndSubmissionId(c);
  const parsed = commentEditSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid comment edit payload.", parsed.error.flatten());
  }

  const submission = await getSubmissionById(c.env.DB, submissionId);
  if (!submission || submission.kind !== "comment") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Comment submission was not found.");
  }
  const isAuthor = submission.userId === user.uid;
  const isAdmin = user.role === "a" || user.role === "r";
  if (!isAuthor && !isAdmin) {
    throw new ApiError(403, "COMMENT_EDIT_OWNER_ONLY", "Only the author or an admin can edit a comment.");
  }
  if (!["pending_openai", "pending_audit", "active", "flagged", "remove_request"].includes(submission.status)) {
    throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Comment cannot be edited in its current status.", {
      status: submission.status
    });
  }

  if (submission.content === parsed.data.content) {
    return c.json({
      ok: true,
      submission: {
        id: submission.id,
        markerId: submission.markerId,
        parentId: submission.parentId,
        depth: submission.commentDepth,
        status: submission.status,
        snapshotId: submission.snapshotId
      }
    });
  }

  const snapshotId = nanoid(12);
  const updated = await updateCommentContentForModeration(c.env.DB, {
    id: submissionId,
    content: parsed.data.content,
    expectedSnapshotId: submission.snapshotId,
    snapshotId,
    moderationNote: `${
      isAuthor
        ? COMMENT_EDIT_MODERATION_NOTE_PREFIX
        : COMMENT_ADMIN_EDIT_MODERATION_NOTE_PREFIX
    } awaiting moderation.`
  });
  if (!updated) {
    throw new ApiError(409, "COMMENT_EDIT_CONFLICT", "Comment changed while the edit was being submitted.");
  }
  await clearSubmissionFlags(c.env.DB, submissionId);
  invalidateCommentCache(c, submission.markerId);
  await enqueueModeration(c.env, submissionId, snapshotId);

  return c.json({
    ok: true,
    submission: {
      id: submission.id,
      markerId: submission.markerId,
      parentId: submission.parentId,
      depth: submission.commentDepth,
      status: "pending_openai",
      snapshotId
    }
  });
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
  if (submission.editOriginalContent !== null) {
    const originalStatus = submission.editOriginalStatus;
    const status = originalStatus === "pending_openai" || originalStatus === "pending_audit"
      ? originalStatus
      : "active";
    const reverted = await revertCommentEdit(c.env.DB, {
      id: submissionId,
      expectedSnapshotId: submission.snapshotId,
      status,
      moderationNote: "Comment edit reverted by author."
    });
    if (!reverted) {
      throw new ApiError(409, "COMMENT_EDIT_CONFLICT", "Comment changed while the edit was being reverted.");
    }
    invalidateCommentCache(c, submission.markerId);
    if (status === "pending_openai" && submission.editOriginalSnapshotId) {
      await enqueueModeration(c.env, submissionId, submission.editOriginalSnapshotId);
    }
    return c.json({
      ok: true,
      status,
      editReverted: true,
      content: submission.editOriginalContent
    });
  }
  if (submission.status === "stale") {
    return c.json({ ok: true, status: "stale" });
  }
  if (!["pending_openai", "pending_audit", "active", "flagged", "remove_request"].includes(submission.status)) {
    throw new ApiError(409, "INVALID_STATUS_TRANSITION", "Comment cannot be recalled from its current status.", {
      from: submission.status,
      to: "stale"
    });
  }

  const transition = await transitionSubmissionStatusWithNotifications(c.env.DB, {
    submission,
    status: "stale",
    moderationNote: `${RECALL_MODERATION_NOTE_PREFIX} comment withdrawn by author.`,
    source: "user_action"
  });
  if (!transition.updated) {
    throw new ApiError(409, "RECALL_CONFLICT", "Comment changed while it was being recalled.");
  }
  if (transition.notifications.length > 0) {
    c.executionCtx.waitUntil(publishNotificationsCreated(c.env, transition.notifications));
  }
  invalidateCommentCache(c, submission.markerId);
  return c.json({ ok: true, status: "stale" });
}
