import { nanoid } from "nanoid";
import { ApiError } from "../../lib/errors";
import { createRedisClient } from "../../lib/redis";
import { createPendingSubmission } from "../../repositories/submission/createSubmission";
import { getSubmissionById } from "../../repositories/submission/statusSubmission";
import type { AppEnv } from "../../types/app";
import { enqueueModeration } from "../moderation";
import { commentSubmissionSchema } from "./schemas";
import { normalizePathPart } from "./storage";

export async function handleSubmitComment(c: import("hono").Context<AppEnv>) {
  const user = c.get("authUser");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }

  const parsed = commentSubmissionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid comment payload.", parsed.error.flatten());
  }

  const submissionId = nanoid(18);
  const snapshotId = nanoid(12);
  const poiType = normalizePathPart(parsed.data.poiType);
  const poiHash = normalizePathPart(parsed.data.poiHash);
  let parentId: string | null = null;
  let commentDepth = 0;

  if (parsed.data.parentId) {
    const parent = await getSubmissionById(c.env.DB, parsed.data.parentId);
    if (!parent || parent.kind !== "comment" || parent.commentDepth !== 0 || parent.parentId !== null) {
      throw new ApiError(404, "PARENT_COMMENT_NOT_FOUND", "Parent comment was not found.");
    }
    if (
      parent.markerId !== parsed.data.markerId ||
      parent.poiHash !== poiHash ||
      parent.poiType !== poiType
    ) {
      throw new ApiError(409, "PARENT_COMMENT_MISMATCH", "Parent comment belongs to a different POI.");
    }
    if (!["active", "flagged", "remove_request"].includes(parent.status)) {
      throw new ApiError(409, "PARENT_COMMENT_NOT_VISIBLE", "Replies can only target visible top-level comments.", {
        status: parent.status
      });
    }
    parentId = parent.id;
    commentDepth = 1;
  }

  await createPendingSubmission(c.env.DB, {
    id: submissionId,
    markerId: parsed.data.markerId,
    poiHash,
    poiType,
    snapshotId,
    userId: user.uid,
    content: parsed.data.content,
    kind: "comment",
    status: "pending_openai",
    parentId,
    commentDepth
  });
  await enqueueModeration(createRedisClient(c.env), submissionId);

  return c.json({
    ok: true,
    submission: {
      id: submissionId,
      markerId: parsed.data.markerId,
      parentId,
      depth: commentDepth,
      status: "pending_openai",
      snapshotId
    }
  });
}
