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
    throw new ApiError(401, "UNAUTHORIZED", "Session has expired, missing, or invalid.");
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
      throw new ApiError(403, "FORBIDDEN", "Insufficient permissions.");
    }
    await next();
  };
}
