import { getRuntimeConfig } from "../../lib/config";
import { ApiError } from "../../lib/errors";
import { RECALL_MODERATION_NOTE_PREFIX } from "../../lib/moderation";
import { prewarmPublicUgcAsset } from "../../middleware/cache/publicUgcAssets";
import { invalidateUploadCaches } from "../../middleware/cache/uploadCaches";
import {
  countSubmissionUpvotes,
  createSubmissionUpvote,
  deleteSubmissionUpvote,
} from "../../repositories/submission/voteSubmission";
import {
  countSubmissionFlags,
  createSubmissionFlag,
  deleteSubmissionFlag,
} from "../../repositories/submission/flagSubmission";
import {
  getSubmissionById,
  updateSubmissionStatus,
  updateSubmissionStatusForSnapshot
} from "../../repositories/submission/statusSubmission";
import type { AppEnv } from "../../types/app";
import {
  notifyFlagCreated,
  notifyFlagRemoved,
  notifyRemoveRequestCancelled,
  notifyRemoveRequestCreated
} from "../moderation/notifications";

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

function invalidateImageCache(c: import("hono").Context<AppEnv>, markerId: string): void {
  c.executionCtx.waitUntil(invalidateUploadCaches({
    kv: c.env.OEM_KV,
    kind: "image",
    markerId
  }));
}

function prewarmIfActive(c: import("hono").Context<AppEnv>, status: string, filePath: string | null): void {
  if (status !== "active") return;
  const config = getRuntimeConfig(c.env);
  c.executionCtx.waitUntil(prewarmPublicUgcAsset(config.ugcAssetBaseUrl, filePath));
}

export async function handleImageUpvote(c: import("hono").Context<AppEnv>) {
  const { user, submissionId } = requireUserAndSubmissionId(c);
  const submission = await getSubmissionById(c.env.DB, submissionId);
  if (!submission || submission.kind !== "image") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
  }
  if (!["active", "flagged", "remove_request"].includes(submission.status)) {
    throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only visible images can be upvoted.", {
      status: submission.status
    });
  }

  const created = await createSubmissionUpvote(c.env.DB, {
    submissionId,
    userId: user.uid
  });
  const upvoteCount = await countSubmissionUpvotes(c.env.DB, submissionId);
  invalidateImageCache(c, submission.markerId);

  return c.json({ ok: true, created, upvoteCount });
}

export async function handleImageUnvote(c: import("hono").Context<AppEnv>) {
  const { user, submissionId } = requireUserAndSubmissionId(c);
  const submission = await getSubmissionById(c.env.DB, submissionId);
  if (!submission || submission.kind !== "image") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
  }
  if (!["active", "flagged", "remove_request"].includes(submission.status)) {
    throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only visible images can be unvoted.", {
      status: submission.status
    });
  }

  const deleted = await deleteSubmissionUpvote(c.env.DB, {
    submissionId,
    userId: user.uid
  });
  const upvoteCount = await countSubmissionUpvotes(c.env.DB, submissionId);
  invalidateImageCache(c, submission.markerId);

  return c.json({ ok: true, deleted, upvoteCount });
}

export async function handleFlagImage(c: import("hono").Context<AppEnv>) {
  const { user, submissionId } = requireUserAndSubmissionId(c);
  const submission = await getSubmissionById(c.env.DB, submissionId);
  if (!submission || submission.kind !== "image") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
  }
  if (submission.userId === user.uid) {
    throw new ApiError(403, "CANNOT_FLAG_OWN_SUBMISSION", "You cannot flag your own image.");
  }
  if (submission.status !== "active" && submission.status !== "flagged") {
    throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only active or flagged images can be flagged.", {
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
  invalidateImageCache(c, submission.markerId);
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

export async function handleUnflagImage(c: import("hono").Context<AppEnv>) {
  const { user, submissionId } = requireUserAndSubmissionId(c);
  const submission = await getSubmissionById(c.env.DB, submissionId);
  if (!submission || submission.kind !== "image") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
  }
  if (submission.userId === user.uid) {
    throw new ApiError(403, "CANNOT_UNFLAG_OWN_SUBMISSION", "You cannot unflag your own image.");
  }
  if (submission.status !== "active" && submission.status !== "flagged") {
    throw new ApiError(409, "INVALID_SUBMISSION_STATUS", "Only active or flagged images can be unflagged.", {
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
    prewarmIfActive(c, status, submission.filePath);
  }
  invalidateImageCache(c, submission.markerId);
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

export async function handleImageRemoveRequest(c: import("hono").Context<AppEnv>) {
  const { user, submissionId } = requireUserAndSubmissionId(c);
  const submission = await getSubmissionById(c.env.DB, submissionId);
  if (!submission) {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission was not found.");
  }
  if (submission.userId !== user.uid) {
    throw new ApiError(403, "REMOVE_REQUEST_OWNER_ONLY", "Only the uploader can request image removal.");
  }
  if (submission.status !== "active" && submission.status !== "flagged") {
    throw new ApiError(409, "INVALID_STATUS_TRANSITION", "Only visible images can receive a remove request.", {
      from: submission.status,
      to: "remove_request"
    });
  }

  await updateSubmissionStatus(c.env.DB, {
    id: submissionId,
    status: "remove_request",
    moderationNote: "Removal requested by uploader."
  });
  invalidateImageCache(c, submission.markerId);
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

export async function handleUnrecallImage(c: import("hono").Context<AppEnv>) {
  const { user, submissionId } = requireUserAndSubmissionId(c);
  const submission = await getSubmissionById(c.env.DB, submissionId);
  if (!submission || submission.kind !== "image") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
  }
  if (submission.userId !== user.uid) {
    throw new ApiError(403, "RECALL_OWNER_ONLY", "Only the uploader can cancel image recall.");
  }
  if (submission.status !== "remove_request") {
    throw new ApiError(409, "INVALID_STATUS_TRANSITION", "Only remove requests can be cancelled.", {
      from: submission.status,
      to: "active"
    });
  }

  const flagCount = await countSubmissionFlags(c.env.DB, submissionId);
  const status = flagCount > 0 ? "flagged" : "active";
  await updateSubmissionStatus(c.env.DB, {
    id: submissionId,
    status,
    moderationNote: "Removal request cancelled by uploader."
  });
  prewarmIfActive(c, status, submission.filePath);
  invalidateImageCache(c, submission.markerId);
  c.executionCtx.waitUntil(
    notifyRemoveRequestCancelled(c.env, {
      submission,
      actor: user,
      nextStatus: status,
      flagCount
    })
  );

  return c.json({ ok: true, status, flagCount });
}

export async function handleRecallImage(c: import("hono").Context<AppEnv>) {
  const { user, submissionId } = requireUserAndSubmissionId(c);
  const submission = await getSubmissionById(c.env.DB, submissionId);
  if (!submission || submission.kind !== "image") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Image submission was not found.");
  }
  if (submission.userId !== user.uid) {
    throw new ApiError(403, "RECALL_OWNER_ONLY", "Only the uploader can recall an image.");
  }
  if (submission.status === "stale") {
    return c.json({ ok: true, status: "stale" });
  }
  if (!["pending_openai", "pending_audit", "active", "flagged", "remove_request"].includes(submission.status)) {
    throw new ApiError(409, "INVALID_STATUS_TRANSITION", "Image cannot be recalled from its current status.", {
      from: submission.status,
      to: "stale"
    });
  }

  const recalled = await updateSubmissionStatusForSnapshot(c.env.DB, {
    id: submissionId,
    snapshotId: submission.snapshotId,
    fromStatus: submission.status,
    status: "stale",
    moderationNote: `${RECALL_MODERATION_NOTE_PREFIX} image withdrawn by uploader.`
  });
  if (!recalled) {
    throw new ApiError(409, "RECALL_CONFLICT", "Image changed while it was being recalled.");
  }
  invalidateImageCache(c, submission.markerId);
  return c.json({ ok: true, status: "stale" });
}
