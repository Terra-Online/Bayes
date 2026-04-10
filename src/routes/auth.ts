import { Hono } from "hono";
import { z } from "zod";
import { createAuth } from "../lib/auth";
import { ApiError } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { formatPublicUid, getErrorMessage, updateUserNickname } from "../repositories/users";
import type { AppEnv, AuthUser } from "../types/app";

const profileUpdateSchema = z.object({
  nickname: z
    .string()
    .trim()
    .min(2, "Nickname must be at least 2 characters.")
    .max(26, "Nickname must be 26 characters or fewer.")
    .regex(/^[A-Za-z0-9_-]+$/, "Nickname can only contain letters, numbers, '_' or '-'.")
});

function toSessionUser(user: AuthUser) {
  return {
    uid: user.publicUid,
    role: user.role,
    karma: user.karma,
    email: user.email,
    nickname: user.nickname,
    needsProfileSetup: user.needsProfileSetup
  };
}

export function createAuthRoutes() {
  const app = new Hono<AppEnv>();

  // Legacy endpoints are intentionally disabled to enforce social-only auth.
  app.post("/register", rateLimit("public"), async (c) => {
    throw new ApiError(
      410,
      "AUTH_METHOD_DISABLED",
      "Email register is disabled. Use social login via /auth/v1/sign-in/social with provider google or discord."
    );
  });

  app.post("/login", rateLimit("public"), async (c) => {
    throw new ApiError(
      410,
      "AUTH_METHOD_DISABLED",
      "Email login is disabled. Use social login via /auth/v1/sign-in/social with provider google or discord."
    );
  });

  app.get("/session", rateLimit("auth"), requireAuth, async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    return c.json({ user: toSessionUser(user) });
  });

  app.patch("/profile", rateLimit("auth"), requireAuth, async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
    let body: unknown;

    if (contentType.includes("application/json") || contentType.length === 0) {
      try {
        body = await c.req.json();
      } catch {
        const rawText = await c.req.text();
        const params = new URLSearchParams(rawText);
        const nickname = params.get("nickname");
        if (nickname !== null) {
          body = { nickname };
        } else {
          throw new ApiError(422, "VALIDATION_ERROR", "Request body must be valid JSON.");
        }
      }
    } else if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const form = await c.req.parseBody();
      body = {
        nickname: typeof form.nickname === "string" ? form.nickname : undefined
      };
    } else {
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported content-type for profile update.");
    }

    const parsed = profileUpdateSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid profile payload.", parsed.error.flatten());
    }

    try {
      const updated = await updateUserNickname(c.env.DB, {
        uid: user.uid,
        nickname: parsed.data.nickname
      });

      return c.json({
        user: {
          uid: formatPublicUid(updated.uidNumber, updated.uidSuffix),
          role: updated.role,
          karma: updated.karma,
          email: updated.email,
          nickname: updated.nickname,
          needsProfileSetup: !updated.nicknameCustomized
        }
      });
    } catch (error) {
      const message = getErrorMessage(error);
      if (message.includes("INVALID_NICKNAME_FORMAT")) {
        throw new ApiError(422, "INVALID_NICKNAME_FORMAT", "Nickname format is invalid.");
      }
      if (message.includes("NICKNAME_CONFLICT")) {
        throw new ApiError(409, "NICKNAME_TAKEN", "Nickname is already in use.");
      }
      if (message.includes("USER_NOT_FOUND")) {
        throw new ApiError(404, "USER_NOT_FOUND", "User profile not found.");
      }
      throw new ApiError(500, "PROFILE_UPDATE_FAILED", message);
    }
  });

  app.post("/logout", rateLimit("auth"), async (c) => {
    const auth = createAuth(c.env);
    await auth.api.signOut({
      headers: c.req.raw.headers
    });
    return c.json({ ok: true });
  });

  app.on(["GET", "POST", "OPTIONS"], "/*", (c) => {
    const auth = createAuth(c.env);
    return auth.handler(c.req.raw);
  });

  return app;
}
