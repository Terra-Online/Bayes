import type { Context } from "hono";

import { getRuntimeConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { getPublicImageById } from "@/repositories/submission/getPublicImage";
import { imageQuerySchema } from "@/routes/schema/uploads";
import type { AppEnv } from "@/types/app";

import { getOptionalAuthIdentity } from "./helpers";
import { resolveImageScope, resolvePublicAssetBaseUrl } from "./scope";

export async function handleGetPublicImage<E extends AppEnv>(c: Context<E, "/images/:id">) {
  const parsed = imageQuerySchema.safeParse({
    markerId: c.req.query("markerId"),
    scope: c.req.query("scope"),
  });
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.", parsed.error.flatten());
  }

  const config = getRuntimeConfig(c.env);
  const scope = resolveImageScope(c.req.raw, config.ugcUploadPathPrefix, parsed.data.scope);
  const identity = await getOptionalAuthIdentity(c.env, c.req.raw.headers);
  const item = await getPublicImageById(c.env.DB, {
    id: c.req.param("id"),
    markerId: parsed.data.markerId,
    assetBaseUrl: resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl),
    ...scope,
    viewerUserId: identity?.uid,
  });
  if (!item) {
    throw new ApiError(404, "NOT_FOUND", "Image not found.");
  }
  const response = c.json({ item });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
