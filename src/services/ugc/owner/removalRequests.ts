import { getRuntimeConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { prewarmPublicUgcAsset } from "@/lib/publicUgcAssets";
import { invalidateUploadCaches } from "@/publicRead/client/invalidate";
import { countSubmissionFlags } from "@/repositories/submission/flagSubmission";
import { updateSubmissionStatus } from "@/repositories/submission/statusSubmission";
import {
  notifyRemoveRequestCancelled,
  notifyRemoveRequestCreated,
} from "@/services/moderation/notifications";
import type {
  SubmissionActionInput,
  UgcActionDependencies,
  UgcActionInput,
} from "@/services/ugc/contract/actions";
import { requireSubmission } from "@/services/ugc/read/submissions";

export async function requestSubmissionRemoval(
  dependencies: UgcActionDependencies,
  input: SubmissionActionInput,
) {
  const { bindings } = dependencies;
  const submission = await requireSubmission(bindings.DB, input);
  const isComment = submission.kind === "comment";
  if (submission.userId !== input.actor.uid) {
    throw new ApiError(
      403,
      "REMOVE_REQUEST_OWNER_ONLY",
      isComment
        ? "Only the author can request comment removal."
        : "Only the uploader can request image removal.",
    );
  }
  if (submission.status !== "active" && submission.status !== "flagged") {
    throw new ApiError(
      409,
      "INVALID_STATUS_TRANSITION",
      `Only visible ${isComment ? "comments" : "images"} can receive a remove request.`,
      { from: submission.status, to: "remove_request" },
    );
  }

  await updateSubmissionStatus(bindings.DB, {
    id: input.submissionId,
    status: "remove_request",
    moderationNote: isComment ? "Removal requested by author." : "Removal requested by uploader.",
  });
  dependencies.defer(
    invalidateUploadCaches({
      kv: bindings.OEM_KV,
      kind: submission.kind,
      markerId: submission.markerId,
    }),
  );
  dependencies.defer(
    notifyRemoveRequestCreated(bindings, {
      submission,
      actor: input.actor,
      nextStatus: "remove_request",
      source: "remove_request",
    }),
  );

  return { status: "remove_request" as const };
}

export async function cancelRemoveImageRequest(
  dependencies: UgcActionDependencies,
  input: UgcActionInput,
) {
  const { bindings } = dependencies;
  const submission = await requireSubmission(bindings.DB, {
    submissionId: input.submissionId,
    kind: "image",
  });
  if (submission.userId !== input.actor.uid) {
    throw new ApiError(403, "RECALL_OWNER_ONLY", "Only the uploader can cancel image recall.");
  }
  if (submission.status !== "remove_request") {
    throw new ApiError(409, "INVALID_STATUS_TRANSITION", "Only remove requests can be cancelled.", {
      from: submission.status,
      to: "active",
    });
  }

  const flagCount = await countSubmissionFlags(bindings.DB, input.submissionId);
  const status = flagCount > 0 ? "flagged" : "active";
  await updateSubmissionStatus(bindings.DB, {
    id: input.submissionId,
    status,
    moderationNote: "Removal request cancelled by uploader.",
  });
  if (status === "active") {
    const config = getRuntimeConfig(bindings);
    dependencies.defer(prewarmPublicUgcAsset(config.ugcAssetBaseUrl, submission.filePath));
  }
  dependencies.defer(
    invalidateUploadCaches({ kv: bindings.OEM_KV, kind: "image", markerId: submission.markerId }),
  );
  dependencies.defer(
    notifyRemoveRequestCancelled(bindings, {
      submission,
      actor: input.actor,
      nextStatus: status,
      flagCount,
    }),
  );

  return { status, flagCount };
}
