import { getRuntimeConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { prewarmPublicUgcAsset } from "@/lib/publicUgcAssets";
import { invalidateUploadCaches } from "@/publicRead/client/invalidate";
import {
  countSubmissionFlags,
  createSubmissionFlag,
  deleteSubmissionFlag,
} from "@/repositories/submission/flagSubmission";
import { updateSubmissionStatus } from "@/repositories/submission/statusSubmission";
import { notifyFlagCreated, notifyFlagRemoved } from "@/services/moderation/notifications";
import type { SubmissionActionInput, UgcActionDependencies } from "@/services/ugc/contract/actions";
import { requireSubmission } from "@/services/ugc/read/submissions";

export async function flagSubmission(
  dependencies: UgcActionDependencies,
  input: SubmissionActionInput,
) {
  const { bindings } = dependencies;
  const submission = await requireSubmission(bindings.DB, input);
  const label = input.kind === "comment" ? "comment" : "image";
  if (submission.userId === input.actor.uid) {
    throw new ApiError(403, "CANNOT_FLAG_OWN_SUBMISSION", `You cannot flag your own ${label}.`);
  }
  if (submission.status !== "active" && submission.status !== "flagged") {
    throw new ApiError(
      409,
      "INVALID_SUBMISSION_STATUS",
      `Only active or flagged ${label}s can be flagged.`,
      {
        status: submission.status,
      },
    );
  }

  const created = await createSubmissionFlag(bindings.DB, {
    submissionId: input.submissionId,
    userId: input.actor.uid,
  });
  if (created && submission.status === "active") {
    await updateSubmissionStatus(bindings.DB, {
      id: input.submissionId,
      status: "flagged",
      moderationNote: "Flagged by user.",
    });
  }
  const flagCount = await countSubmissionFlags(bindings.DB, input.submissionId);
  dependencies.defer(
    invalidateUploadCaches({
      kv: bindings.OEM_KV,
      kind: submission.kind,
      markerId: submission.markerId,
    }),
  );
  if (created) {
    dependencies.defer(
      notifyFlagCreated(bindings, {
        submission,
        actor: input.actor,
        changed: created,
        flagCount,
        nextStatus: "flagged",
      }),
    );
  }

  return { created, status: "flagged" as const, flagCount };
}

export async function unflagSubmission(
  dependencies: UgcActionDependencies,
  input: SubmissionActionInput,
) {
  const { bindings } = dependencies;
  const submission = await requireSubmission(bindings.DB, input);
  const label = input.kind === "comment" ? "comment" : "image";
  if (submission.userId === input.actor.uid) {
    throw new ApiError(403, "CANNOT_UNFLAG_OWN_SUBMISSION", `You cannot unflag your own ${label}.`);
  }
  if (submission.status !== "active" && submission.status !== "flagged") {
    throw new ApiError(
      409,
      "INVALID_SUBMISSION_STATUS",
      `Only active or flagged ${label}s can be unflagged.`,
      {
        status: submission.status,
      },
    );
  }

  const deleted = await deleteSubmissionFlag(bindings.DB, {
    submissionId: input.submissionId,
    userId: input.actor.uid,
  });
  const flagCount = await countSubmissionFlags(bindings.DB, input.submissionId);
  const status = flagCount > 0 ? "flagged" : "active";
  if (submission.status !== status) {
    await updateSubmissionStatus(bindings.DB, {
      id: input.submissionId,
      status,
      moderationNote: status === "active" ? "User flag removed." : undefined,
    });
    if (status === "active" && submission.kind === "image") {
      const config = getRuntimeConfig(bindings);
      dependencies.defer(prewarmPublicUgcAsset(config.ugcAssetBaseUrl, submission.filePath));
    }
  }
  dependencies.defer(
    invalidateUploadCaches({
      kv: bindings.OEM_KV,
      kind: submission.kind,
      markerId: submission.markerId,
    }),
  );
  if (deleted) {
    dependencies.defer(
      notifyFlagRemoved(bindings, {
        submission,
        actor: input.actor,
        changed: deleted,
        flagCount,
        nextStatus: status,
      }),
    );
  }

  return { deleted, status, flagCount };
}
