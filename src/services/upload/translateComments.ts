import { ApiError } from "../../lib/errors";
import type { AppEnv } from "../../types/app";
import { translateVisibleComments } from "../comment-translation";
import { commentTranslationSchema } from "./schemas";

export async function handleTranslateComments(c: import("hono").Context<AppEnv>) {
  const parsed = commentTranslationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid translation payload.", parsed.error.flatten());
  }

  return c.json(await translateVisibleComments(c.env, parsed.data));
}
