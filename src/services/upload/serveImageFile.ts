import { ApiError } from "../../lib/errors";
import { UGC_PUBLIC_IMAGE_CACHE_CONTROL } from "../../middleware/cache/publicUgcAssets";
import { getImageSubmissionByFilePath, getPublicSubmissionByFilePath } from "../../repositories/submission/statusSubmission";
import type { AppEnv } from "../../types/app";
import { parseObjectKeyFromRequestPath } from "./helpers";

function canReadPrivateImage(user: NonNullable<AppEnv["Variables"]["authUser"]>, submissionUserId: string, status: string): boolean {
  const effectiveRole = user.role === "r" ? "a" : user.role;
  return effectiveRole === "p" || effectiveRole === "a" || (submissionUserId === user.uid && status !== "stale");
}

export async function handleServePublicImageFile(c: import("hono").Context<AppEnv>) {
  const objectKey = parseObjectKeyFromRequestPath(c.req.path);
  const submission = await getPublicSubmissionByFilePath(c.env.DB, objectKey);
  if (!submission) {
    throw new ApiError(404, "IMAGE_NOT_FOUND", "Image file was not found.");
  }

  const object = await c.env.UGC_BUCKET.get(objectKey);
  if (!object) {
    throw new ApiError(404, "IMAGE_NOT_FOUND", "Image file was not found.");
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", UGC_PUBLIC_IMAGE_CACHE_CONTROL);
  headers.set("Content-Type", object.httpMetadata?.contentType ?? submission.mimeType ?? "application/octet-stream");

  return new Response(object.body, {
    status: 200,
    headers
  });
}

export async function handleServePrivateImageFile(c: import("hono").Context<AppEnv>) {
  const user = c.get("authUser");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }
  const objectKey = parseObjectKeyFromRequestPath(c.req.path);
  const submission = await getImageSubmissionByFilePath(c.env.DB, objectKey);
  if (!submission || !canReadPrivateImage(user, submission.userId, submission.status)) {
    throw new ApiError(404, "IMAGE_NOT_FOUND", "Image file was not found.");
  }

  const object = await c.env.UGC_BUCKET.get(objectKey);
  if (!object) {
    throw new ApiError(404, "IMAGE_NOT_FOUND", "Image file was not found.");
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "private, max-age=60");
  headers.set("Content-Type", object.httpMetadata?.contentType ?? submission.mimeType ?? "application/octet-stream");

  return new Response(object.body, {
    status: 200,
    headers
  });
}
