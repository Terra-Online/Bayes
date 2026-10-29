import { getRuntimeConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { prewarmPublicUgcAsset } from "@/lib/publicUgcAssets";
import { invalidateUploadCaches } from "@/publicRead/client/invalidate";
import { setSubmissionReport } from "@/repositories/submission/flagSubmission";
import { notifyFlagCreated, notifyFlagRemoved } from "@/services/moderation/notifications";
import type { SubmissionActionInput, UgcActionDependencies } from "@/services/ugc/contract/actions";

type ReportInput = SubmissionActionInput & { snapshotId: string };

async function setReport(dependencies: UgcActionDependencies, input: ReportInput, active: boolean) {
  const { bindings } = dependencies;
  const result = await setSubmissionReport(bindings.DB, {
    submissionId: input.submissionId,
    snapshotId: input.snapshotId,
    kind: input.kind,
    userId: input.actor.uid,
    active,
  });
  if (result.outcome === "missing") {
    throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission was not found.");
  }
  if (result.outcome === "forbidden") {
    throw new ApiError(
      403,
      active ? "CANNOT_FLAG_OWN_SUBMISSION" : "CANNOT_UNFLAG_OWN_SUBMISSION",
      `You cannot ${active ? "flag" : "unflag"} your own ${input.kind}.`,
    );
  }
  if (result.outcome !== "committed") {
    throw new ApiError(
      409,
      "PUBLIC_SNAPSHOT_CONFLICT",
      "The public version changed. Refresh before reporting.",
    );
  }
  const status = result.flagCount > 0 ? ("flagged" as const) : ("active" as const);
  const submission = { ...result.submission, status: result.previousStatus };
  dependencies.defer(
    invalidateUploadCaches({
      kv: bindings.OEM_KV,
      kind: input.kind,
      markerId: submission.markerId,
    }),
  );
  if (result.changed) {
    const notify = active ? notifyFlagCreated : notifyFlagRemoved;
    dependencies.defer(
      notify(bindings, {
        submission,
        actor: input.actor,
        changed: true,
        flagCount: result.flagCount,
        nextStatus: status,
      }),
    );
    if (!active && status === "active" && input.kind === "image") {
      dependencies.defer(
        prewarmPublicUgcAsset(getRuntimeConfig(bindings).ugcAssetBaseUrl, submission.filePath),
      );
    }
  }
  return { changed: result.changed, status, flagCount: result.flagCount };
}

export async function flagSubmission(dependencies: UgcActionDependencies, input: ReportInput) {
  const { changed, ...result } = await setReport(dependencies, input, true);
  return { created: changed, ...result };
}

export async function unflagSubmission(dependencies: UgcActionDependencies, input: ReportInput) {
  const { changed, ...result } = await setReport(dependencies, input, false);
  return { deleted: changed, ...result };
}
