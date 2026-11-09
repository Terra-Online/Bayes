import type { HonoRequest } from "hono";

import { ApiError } from "@/lib/errors";
import { parseInput, readJsonBody } from "@/routes/input";
import { profileUpdateSchema } from "@/routes/schema/profile";
import type { UpdateProfileInput } from "@/services/profile";

async function readProfileUpdateBody(request: HonoRequest): Promise<unknown> {
  const contentType = request.header("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/json") || contentType.length === 0) {
    return readJsonBody(request);
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await request.parseBody();
    let rawAvatar: number | undefined;
    if (typeof form.avatar === "string") {
      rawAvatar = Number(form.avatar);
    } else if (typeof form.avt === "string") {
      rawAvatar = Number(form.avt);
    }
    return {
      nickname: typeof form.nickname === "string" ? form.nickname : undefined,
      avatar: rawAvatar,
    };
  }

  throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported content-type for profile update.");
}

function normalizeProfileUpdateBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }

  const nextBody = { ...(body as Record<string, unknown>) };
  if (nextBody.avatar === undefined && nextBody.avt !== undefined) {
    nextBody.avatar = nextBody.avt;
  }
  return nextBody;
}

export async function readProfileUpdateInput(
  request: HonoRequest,
): Promise<Omit<UpdateProfileInput, "userId">> {
  return parseInput(
    profileUpdateSchema,
    normalizeProfileUpdateBody(await readProfileUpdateBody(request)),
    "Invalid profile payload.",
  );
}
