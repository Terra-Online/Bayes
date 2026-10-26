import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";

import { ApiError } from "@/lib/errors";
import { resolveContextAuthUser } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import type { AppEnv, AuthUser } from "@/types/app";

function isUploadsLocked(flag: string | undefined): boolean {
  const normalized = (flag ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

export async function assertActiveUser<
  E extends AppEnv<{ authUser?: AuthUser; authUserPromise?: Promise<AuthUser> }>,
>(c: Context<E>): Promise<void> {
  const user = await resolveContextAuthUser(c);
  if (user.role === "s") {
    throw new ApiError(403, "ACCESS_DENIED", "Suspended users cannot access upload endpoints.");
  }
}

export const requireActiveUser: MiddlewareHandler<
  AppEnv<{ authUser: AuthUser; authUserPromise?: Promise<AuthUser> }>
> = async (c, next) => {
  await assertActiveUser(c);
  await next();
};

export const requireUploadsEnabled: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isUploadsLocked(c.env.LOCK_UPLOAD_ENDPOINTS)) {
    throw new ApiError(
      503,
      "UPLOADS_TEMPORARILY_DISABLED",
      "Upload endpoints are temporarily disabled during stabilization.",
    );
  }
  await next();
};

export function imageListAccess() {
  const publicImageLimit = rateLimit("public");
  const privateImageLimit = rateLimit("auth");
  return createMiddleware<AppEnv<{ authUser?: AuthUser; authUserPromise?: Promise<AuthUser> }>>(
    async (c, next) => {
      const includeMine = c.req.query("includeMine");
      if (includeMine !== undefined && includeMine !== "1") {
        throw new ApiError(422, "VALIDATION_ERROR", "includeMine must be 1 when supplied.");
      }
      if (includeMine === "1") {
        if (c.req.query("publicOnly") === "1") {
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "includeMine and publicOnly cannot be combined.",
          );
        }
        await assertActiveUser(c);
        return privateImageLimit(c, next);
      }
      return publicImageLimit(c, next);
    },
  );
}
