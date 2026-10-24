import { ApiError } from "@/lib/errors";
import {
  getImageSubmissionByFilePath,
  getPublicSubmissionByFilePath,
} from "@/repositories/submission/imageAssets";
import type { AuthUser } from "@/types/app";

type ImageAssetAccess =
  | { kind: "public" }
  | { kind: "viewer"; actor: Pick<AuthUser, "uid" | "role"> };

interface LoadedImageAsset {
  object: R2ObjectBody;
  contentType: string;
}

export async function loadImageAsset(
  resources: { db: D1Database; bucket: R2Bucket },
  input: { objectKey: string; access: ImageAssetAccess },
): Promise<LoadedImageAsset> {
  const access = input.access;
  const submission =
    access.kind === "public"
      ? await getPublicSubmissionByFilePath(resources.db, input.objectKey)
      : await getImageSubmissionByFilePath(resources.db, input.objectKey, {
          userId: access.actor.uid,
          includeAllOwners:
            access.actor.role === "p" || access.actor.role === "a" || access.actor.role === "r",
        });
  // Check access in SQL before selecting a row: snapshots and owners can share a key.
  if (!submission) {
    throw new ApiError(404, "IMAGE_NOT_FOUND", "Image file was not found.");
  }
  const object = await resources.bucket.get(input.objectKey);
  if (!object) {
    throw new ApiError(404, "IMAGE_NOT_FOUND", "Image file was not found.");
  }
  return {
    object,
    contentType:
      object.httpMetadata?.contentType ?? submission.mimeType ?? "application/octet-stream",
  };
}
