import type { MiddlewareHandler } from "hono";
import { createAuth } from "../lib/auth";
import { ApiError } from "../lib/errors";
import { ensureUserProfile, formatPublicUid } from "../repositories/users";
import type { AppEnv, Role } from "../types/app";

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers
  });

  if (!session) {
    const authorization = c.req.header("authorization")?.trim() ?? "";
    const hasBearerToken = authorization.toLowerCase().startsWith("bearer ");
    if (hasBearerToken) {
      throw new ApiError(401, "TOKEN_EXPIRED", "Token is expired, missing, or invalid.");
    }
    throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
  }

  const profile = await ensureUserProfile(c.env.DB, {
    uid: session.user.id,
    email: session.user.email,
    displayName: session.user.name
  });

  c.set("authUser", {
    uid: profile.uid,
    publicUid: formatPublicUid(profile.uidNumber, profile.uidSuffix),
    role: profile.role,
    karma: profile.karma,
    avatar: profile.avt,
    email: profile.email,
    nickname: profile.nickname,
    needsProfileSetup: !profile.nicknameCustomized
  });

  await next();
};

export function requireRole(roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("authUser");
    if (!user || !roles.includes(user.role)) {
      throw new ApiError(403, "ACCESS_DENIED", "Insufficient permissions.");
    }
    await next();
  };
}
