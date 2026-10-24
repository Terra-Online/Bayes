import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import { resolveAuthUser } from "@/lib/auth/identity";
import { getRequestAuthHeaders } from "@/lib/auth/requestHeaders";
import { ApiError } from "@/lib/errors";
import type { AppEnv, AuthUser, Role } from "@/types/app";

export const requireAuth = createMiddleware<AppEnv<{ authUser: AuthUser }>>(async (c, next) => {
  c.set("authUser", await getAuthUser(c));
  await next();
});

export function requireRole(roles: Role[]) {
  return createMiddleware<AppEnv<{ authUser: AuthUser }>>(async (c, next) => {
    const user = c.get("authUser");
    const effectiveRole = user.role === "r" ? "a" : user.role;
    if (!roles.includes(effectiveRole)) {
      throw new ApiError(403, "ACCESS_DENIED", "Insufficient permissions.");
    }
    await next();
  });
}

export async function getAuthUser<E extends AppEnv<{ authUser?: AuthUser }>>(
  c: Context<E>,
): Promise<AuthUser> {
  return c.get("authUser") ?? (await resolveAuthUser(c.env, getRequestAuthHeaders(c.req.raw)));
}
