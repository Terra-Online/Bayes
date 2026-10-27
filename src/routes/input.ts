import type { HonoRequest } from "hono";
import type { z } from "zod";

import { ApiError } from "@/lib/errors";

export async function readJsonBody(request: HonoRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
}

export async function readJsonObject(request: HonoRequest): Promise<Record<string, unknown>> {
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid payload.");
  }
  return body as Record<string, unknown>;
}

export function parseInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
  message = "Invalid payload.",
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", message, parsed.error.flatten());
  }
  return parsed.data;
}
