import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import { ApiError } from "@/lib/errors";
import { getAuthUser } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import type { AppEnv, AuthUser } from "@/types/app";

function isUploadsLocked(flag: string | undefined): boolean {
  const normalized = (flag ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

function assertNotSuspended(user: AuthUser): void {
  if (user.role === "s") {
    throw new ApiError(403, "ACCESS_DENIED", "Suspended users cannot access upload endpoints.");
  }
}

export async function assertActiveUser<E extends AppEnv<{ authUser?: AuthUser }>>(
  c: Context<E>,
): Promise<AuthUser> {
  const user = await getAuthUser(c);
  assertNotSuspended(user);
  return user;
}

export const requireActiveUser = createMiddleware<AppEnv<{ authUser: AuthUser }>>(
  async (c, next) => {
    c.set("authUser", await assertActiveUser(c));
    await next();
  },
);

export const requireUploadsEnabled = createMiddleware<AppEnv>(async (c, next) => {
  if (isUploadsLocked(c.env.LOCK_UPLOAD_ENDPOINTS)) {
    throw new ApiError(
      503,
      "UPLOADS_TEMPORARILY_DISABLED",
      "Upload endpoints are temporarily disabled during stabilization.",
    );
  }
  await next();
});

type ImageListAccess = { kind: "public" } | { kind: "includeMine"; user: AuthUser };

export const parseImageListAccess = createMiddleware<
  AppEnv<{
    imageListAccess: ImageListAccess;
    authUser?: AuthUser;
  }>
>(async (c, next) => {
  const includeMine = c.req.query("includeMine");
  if (includeMine !== undefined && includeMine !== "1") {
    throw new ApiError(422, "VALIDATION_ERROR", "includeMine must be 1 when supplied.");
  }
  if (includeMine === "1") {
    if (c.req.query("publicOnly") === "1") {
      throw new ApiError(422, "VALIDATION_ERROR", "includeMine and publicOnly cannot be combined.");
    }
    const user = await assertActiveUser(c);
    c.set("authUser", user);
    c.set("imageListAccess", { kind: "includeMine", user });
  } else {
    c.set("imageListAccess", { kind: "public" });
  }
  await next();
});

type ImageListRateLimitEnv = AppEnv<{ imageListAccess: ImageListAccess; authUser?: AuthUser }>;
const publicImageLimit = rateLimit<ImageListRateLimitEnv>("public");
const privateImageLimit = rateLimit<ImageListRateLimitEnv>("auth");

export const imageListRateLimit = createMiddleware<ImageListRateLimitEnv>((c, next) => {
  const access = c.get("imageListAccess");
  return access.kind === "includeMine" ? privateImageLimit(c, next) : publicImageLimit(c, next);
});
