import { z } from "zod";

import { ApiError } from "@/lib/errors";
import { invalidateUploadCaches } from "@/publicRead/client/invalidate";
import { appendVersion, getSubmissionKind } from "@/repositories/submission/appendVersion";
import { markAutomaticReviewQueued } from "@/repositories/submission/automaticReviewQueue";
import {
  correctSnapshotReview,
  type ReviewCorrection,
} from "@/repositories/submission/correctReview";
import { changeSubmissionDeletion } from "@/repositories/submission/lifecycle";
import { commentContentSchema } from "@/services/ugc/contract/commentContent";

import type { ManualModerationDependencies } from "./manualModeration";

export async function administerDeletion(
  dependencies: ManualModerationDependencies,
  input: {
    submissionId: string;
    actorId: string;
    action: "deleted" | "restored";
    expectedLifecycleVersion: number;
    expectedSnapshotId?: string;
    note?: string;
  },
) {
  const result = await changeSubmissionDeletion(dependencies.bindings.DB, {
    ...input,
    permission: "admin",
    snapshotId: input.expectedSnapshotId,
  });
  if (result.outcome === "missing") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission not found.");
  }
  if (result.outcome === "forbidden") {
    throw new ApiError(403, "FORBIDDEN", "Administrator access required.");
  }
  if (result.outcome === "conflict") {
    throw new ApiError(409, "MODERATION_CONFLICT", "The inspected submission changed.");
  }
  if (result.outcome === "committed") {
    dependencies.defer(
      invalidateUploadCaches({
        kv: dependencies.bindings.OEM_KV,
        kind: result.target.kind,
        markerId: result.target.markerId,
      }),
    );
  }
  return { outcome: result.outcome, ...result.target };
}

export async function administerReview(
  dependencies: ManualModerationDependencies,
  input: ReviewCorrection,
) {
  const result = await correctSnapshotReview(dependencies.bindings.DB, input);
  if (result.outcome === "missing") {
    throw new ApiError(404, "SNAPSHOT_NOT_FOUND", "Snapshot not found.");
  }
  if (result.outcome === "forbidden") {
    throw new ApiError(403, "FORBIDDEN", "Administrator access required.");
  }
  if (result.outcome === "conflict") {
    throw new ApiError(409, "MODERATION_CONFLICT", "The inspected review changed.");
  }
  if (result.outcome === "committed") {
    dependencies.defer(
      invalidateUploadCaches({
        kv: dependencies.bindings.OEM_KV,
        kind: result.target.kind,
        markerId: result.target.markerId,
      }),
    );
  }
  return { outcome: result.outcome };
}

export async function administerRevision(
  dependencies: ManualModerationDependencies,
  input: {
    submissionId: string;
    actorId: string;
    expectedSnapshotId: string;
    content?: string;
    sourceSnapshotId?: string;
    note?: string;
  },
) {
  const identity = await getSubmissionKind(dependencies.bindings.DB, input.submissionId);
  if (!identity) {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission not found.");
  }
  let content = input.content;
  if (content !== undefined) {
    const parsed = (
      identity.kind === "comment" ? commentContentSchema : z.string().max(1000)
    ).safeParse(content);
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid content.");
    }
    content = parsed.data;
  }
  const result = await appendVersion(dependencies.bindings.DB, {
    ...input,
    content,
    mode: "admin",
    parentSnapshotId: input.expectedSnapshotId,
    snapshotId: crypto.randomUUID(),
  });
  if (result.outcome === "not_found") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission not found.");
  }
  if (result.outcome === "unauthorized") {
    throw new ApiError(403, "FORBIDDEN", "Administrator access required.");
  }
  if (result.outcome === "conflict") {
    throw new ApiError(409, "MODERATION_CONFLICT", "The current revision is pending or changed.");
  }
  if (result.outcome === "appended") {
    dependencies.defer(
      invalidateUploadCaches({
        kv: dependencies.bindings.OEM_KV,
        kind: result.kind,
        markerId: result.submission.markerId,
      }),
    );
    if (result.deletedAt === null) {
      const queuedAt = new Date().toISOString();
      await dependencies.bindings.OEM_MODERATION_Q.send({
        type: "moderation",
        submissionId: input.submissionId,
        snapshotId: result.submission.snapshotId,
        source: "upload",
        queuedAt,
      });
      await markAutomaticReviewQueued(dependencies.bindings.DB, {
        id: input.submissionId,
        snapshotId: result.submission.snapshotId,
        queuedAt,
      });
    }
  }
  return { outcome: result.outcome, submission: result.submission };
}
