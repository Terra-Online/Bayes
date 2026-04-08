import { Hono } from "hono";
import { z } from "zod";
import { createAuth } from "../lib/auth";
import { ApiError } from "../lib/errors";
import { rateLimit } from "../middleware/rate-limit";
import { ensureUserProfile } from "../repositories/users";
import type { AppEnv } from "../types/app";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  nickname: z.string().regex(/^[A-Za-z0-9]{1,26}$/),
  avt: z.number().int().min(0).max(999).optional()
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128)
});

export function createAuthRoutes() {
  const app = new Hono<AppEnv>();

  // Compatibility wrappers to preserve the previous API shape.
  app.post("/register", rateLimit("public"), async (c) => {
    const body = registerSchema.safeParse(await c.req.json());
    if (!body.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid register payload.", body.error.flatten());
    }

    const auth = createAuth(c.env);
    const registered = await auth.api.signUpEmail({
      body: {
        email: body.data.email.toLowerCase(),
        password: body.data.password,
        name: body.data.nickname
      },
      headers: c.req.raw.headers
    });

    const profile = await ensureUserProfile(c.env.DB, {
      uid: registered.user.id,
      email: registered.user.email,
      nickname: body.data.nickname,
      avt: body.data.avt
    });

    return c.json(
      {
        token: registered.token,
        user: {
          uid: profile.uid,
          role: profile.role,
          email: profile.email,
          nickname: profile.nickname
        }
      },
      201
    );
  });

  app.post("/login", rateLimit("public"), async (c) => {
    const body = loginSchema.safeParse(await c.req.json());
    if (!body.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid login payload.", body.error.flatten());
    }

    const auth = createAuth(c.env);
    const signedIn = await auth.api.signInEmail({
      body: {
        email: body.data.email.toLowerCase(),
        password: body.data.password,
        rememberMe: true
      },
      headers: c.req.raw.headers
    });

    const profile = await ensureUserProfile(c.env.DB, {
      uid: signedIn.user.id,
      email: signedIn.user.email,
      displayName: signedIn.user.name
    });

    return c.json({
      token: signedIn.token,
      user: {
        uid: profile.uid,
        role: profile.role,
        email: profile.email,
        nickname: profile.nickname
      }
    });
  });

  app.get("/session", rateLimit("auth"), async (c) => {
    const auth = createAuth(c.env);
    const session = await auth.api.getSession({
      headers: c.req.raw.headers
    });

    if (!session) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    const profile = await ensureUserProfile(c.env.DB, {
      uid: session.user.id,
      email: session.user.email,
      displayName: session.user.name
    });

    return c.json({
      user: {
        uid: profile.uid,
        role: profile.role,
        email: profile.email,
        nickname: profile.nickname
      }
    });
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
