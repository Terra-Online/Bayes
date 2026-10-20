import type { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import {
  getLegacyCookieExpirations,
  resolveBrowserSessionHeaders,
  serializeBrowserSessionCookie,
} from "../../lib/auth/browserSession";
import { createAuth } from "../../lib/auth/createAuth";
import { hasSessionCredentials } from "../../lib/auth/sessionCredentials";
import { ApiError } from "../../lib/errors";
import {
  getRequestAuthHeaders,
  invalidateAuthUserCache,
  requireAuth,
  resolveAuthUser,
} from "../../middleware/auth";
import { rateLimit } from "../../middleware/rate-limit";
import { formatPublicUid, getErrorMessage, updateUserNickname } from "../../repositories/users";
import type { AppEnv } from "../../types/app";
import { toSessionUser } from "./sessionUser";

const profileUpdateSchema = z.object({
  nickname: z
    .string()
    .trim()
    .min(2, "Nickname must be at least 2 characters.")
    .max(26, "Nickname must be 26 characters or fewer.")
    .regex(/^[A-Za-z0-9_-]+$/, "Nickname can only contain letters, numbers, '_' or '-'."),
  avatar: z.number().int().min(1).max(99).optional(),
  avt: z.number().int().min(1).max(99).optional(),
});

async function readProfileUpdateBody(c: Context<AppEnv>): Promise<unknown> {
  const contentType = c.req.header("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/json") || contentType.length === 0) {
    try {
      return await c.req.json();
    } catch {
      throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
    }
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await c.req.parseBody();
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

function mapProfileUpdateError(error: unknown): never {
  const message = getErrorMessage(error);
  if (message.includes("INVALID_NICKNAME_FORMAT")) {
    throw new ApiError(422, "INVALID_NICKNAME_FORMAT", "Nickname format is invalid.");
  }
  if (message.includes("INVALID_AVATAR")) {
    throw new ApiError(422, "INVALID_AVATAR", "Avatar is invalid.");
  }
  if (message.includes("NICKNAME_CONFLICT")) {
    throw new ApiError(409, "NICKNAME_TAKEN", "Nickname is already in use.");
  }
  if (message.includes("USER_NOT_FOUND")) {
    throw new ApiError(404, "USER_NOT_FOUND", "User profile not found.");
  }
  throw new ApiError(500, "PROFILE_UPDATE_FAILED", message);
}

export function registerSessionAuthRoutes(app: Hono<AppEnv>) {
  app.get(
    "/session",
    async (c, next) => {
      await next();
      c.header("Cache-Control", "private, no-store");
    },
    async (c, next) => {
      const authHeaders = getRequestAuthHeaders(c.req.raw);
      if (!hasSessionCredentials(c.env, authHeaders)) {
        throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
      }
      const auth = createAuth(c.env);
      const browserSession = resolveBrowserSessionHeaders(auth, authHeaders);
      const { response: session, headers } = await auth.api.getSession({
        headers: browserSession.headers,
        returnHeaders: true,
      });
      for (const cookie of headers.getSetCookie()) {
        c.header("Set-Cookie", cookie, { append: true });
      }
      if (!session) {
        invalidateAuthUserCache(authHeaders, c.env);
        if (authHeaders.get("authorization")?.trim().toLowerCase().startsWith("bearer ")) {
          throw new ApiError(401, "TOKEN_EXPIRED", "Token is expired, missing, or invalid.");
        }
        throw new ApiError(401, "SESSION_REQUIRED", "Session is required.");
      }

      // This fresh, renewing session check also authenticates the middleware.
      // A cached identity with disableRefresh must never replace it.
      c.set(
        "authUser",
        await resolveAuthUser(c.env, authHeaders, {
          uid: session.user.id,
          email: session.user.email,
          displayName: session.user.name,
        }),
      );

      if (browserSession.migrating) {
        c.header("Set-Cookie", await serializeBrowserSessionCookie(auth, session.session), {
          append: true,
        });
      } else if (c.req.header("cookie")?.includes("better-auth.")) {
        for (const cookie of getLegacyCookieExpirations(auth)) {
          c.header("Set-Cookie", cookie, { append: true });
        }
      }
      c.set("authSessionMigrating", browserSession.migrating);
      await next();
    },
    rateLimit("auth"),
    (c) => {
      const user = c.get("authUser")!;
      const response = c.json({
        user: toSessionUser(user),
        ...(c.get("authSessionMigrating") ? { requiresCookieConfirmation: true } : {}),
      });
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    },
  );

  app.patch("/profile", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    const parsed = profileUpdateSchema.safeParse(
      normalizeProfileUpdateBody(await readProfileUpdateBody(c)),
    );
    if (!parsed.success) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Invalid profile payload.",
        parsed.error.flatten(),
      );
    }

    try {
      const updated = await updateUserNickname(c.env.DB, {
        uid: user.uid,
        nickname: parsed.data.nickname,
        avatar: parsed.data.avatar,
      });

      invalidateAuthUserCache(getRequestAuthHeaders(c.req.raw), c.env);

      return c.json({
        user: {
          uid: formatPublicUid(updated.uidNumber, updated.uidSuffix),
          role: updated.role,
          karma: updated.karma,
          avatar: updated.avt,
          email: updated.email,
          nickname: updated.nickname,
          registeredAt: updated.createdAt,
          needsProfileSetup: !updated.nicknameCustomized,
        },
      });
    } catch (error) {
      mapProfileUpdateError(error);
    }
  });
}
