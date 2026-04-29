import { Hono, type Context } from "hono";
import { z } from "zod";
import { createToken, decryptSecret, encryptSecret } from "../lib/crypto";
import {
  generateEndfieldCredByCode,
  getEndfieldPosition,
  getEndfieldRoles,
  grantEndfieldOAuthCode,
  type EndfieldProvider,
  type EndfieldRoleOption
} from "../lib/endfield-client";
import { ApiError } from "../lib/errors";
import { createRedisClient } from "../lib/redis";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import type { AppEnv } from "../types/app";

type BindingStatus = "enabled" | "disabled";
type AppContext = Context<AppEnv>;

type EndfieldBindingRow = {
  uid: string;
  provider: EndfieldProvider;
  server_id: number;
  role_id: string;
  role_nickname: string | null;
  server_name: string | null;
  cred_enc: string;
  token_enc: string;
  status: BindingStatus;
  updated_at: string;
};

type PendingEndfieldSession = {
  provider: EndfieldProvider;
  cred: string;
  token: string;
  roles: EndfieldRoleOption[];
  createdAt: number;
};

const PENDING_TTL_SECONDS = 10 * 60;
const DEFAULT_POSITION_CACHE_TTL_SECONDS = 2;

const providerSchema = z.enum(["skland", "skport"]);
const exchangeTokenSchema = z.object({
  provider: providerSchema,
  token: z.string().trim().min(8).max(4096)
});
const exchangeCodeSchema = z.object({
  provider: providerSchema,
  code: z.string().trim().min(4).max(4096)
});
const bindRoleSchema = z.object({
  flowId: z.string().trim().min(16).max(128),
  serverId: z.number().int().positive(),
  roleId: z.string().trim().min(1).max(128)
});
const roleOptionSchema = z.object({
  serverId: z.number().int().positive(),
  roleId: z.string(),
  nickname: z.string(),
  level: z.number(),
  serverType: z.string(),
  serverName: z.string(),
  isDefault: z.boolean()
});
const pendingSessionSchema = z.object({
  provider: providerSchema,
  cred: z.string(),
  token: z.string(),
  roles: z.array(roleOptionSchema),
  createdAt: z.number()
});

function getCredentialSecret(c: AppContext): string {
  const secret = c.env.ENDFIELD_CREDENTIAL_SECRET ?? c.env.BETTER_AUTH_SECRET;
  if (!secret || secret.trim().length < 16) {
    throw new ApiError(503, "ENDFIELD_CREDENTIAL_SECRET_MISSING", "Endfield credential encryption secret is not configured.");
  }
  return secret;
}

function getPositionCacheTtlSeconds(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_POSITION_CACHE_TTL_SECONDS;
  }
  return Math.min(10, parsed);
}

function getPendingKey(uid: string, flowId: string): string {
  return `binding:endfield:pending:${uid}:${flowId}`;
}

function getPositionCacheKey(uid: string): string {
  return `binding:endfield:position:${uid}`;
}

function publicBinding(row: EndfieldBindingRow | null) {
  if (!row) {
    return {
      bound: false,
      enabled: false
    };
  }

  return {
    bound: true,
    enabled: row.status === "enabled",
    provider: row.provider,
    serverId: row.server_id,
    roleId: row.role_id,
    nickname: row.role_nickname ?? "",
    serverName: row.server_name ?? "",
    updatedAt: row.updated_at
  };
}

async function getBinding(db: D1Database, uid: string): Promise<EndfieldBindingRow | null> {
  return db
    .prepare("SELECT * FROM endfield_bindings WHERE uid = ?1 LIMIT 1")
    .bind(uid)
    .first<EndfieldBindingRow>();
}

async function saveBinding(
  db: D1Database,
  uid: string,
  provider: EndfieldProvider,
  role: EndfieldRoleOption,
  encrypted: { cred: string; token: string }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO endfield_bindings (
        uid, provider, server_id, role_id, role_nickname, server_name, cred_enc, token_enc, status, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'enabled', CURRENT_TIMESTAMP)
      ON CONFLICT(uid) DO UPDATE SET
        provider = excluded.provider,
        server_id = excluded.server_id,
        role_id = excluded.role_id,
        role_nickname = excluded.role_nickname,
        server_name = excluded.server_name,
        cred_enc = excluded.cred_enc,
        token_enc = excluded.token_enc,
        status = 'enabled',
        updated_at = CURRENT_TIMESTAMP`
    )
    .bind(
      uid,
      provider,
      role.serverId,
      role.roleId,
      role.nickname,
      role.serverName,
      encrypted.cred,
      encrypted.token
    )
    .run();
}

async function savePendingSession(
  c: AppContext,
  uid: string,
  session: PendingEndfieldSession
): Promise<string> {
  const redis = createRedisClient(c.env);
  const flowId = createToken(24);
  await redis.set(getPendingKey(uid, flowId), JSON.stringify(session), { ex: PENDING_TTL_SECONDS });
  return flowId;
}

async function readPendingSession(
  c: AppContext,
  uid: string,
  flowId: string
): Promise<PendingEndfieldSession> {
  const redis = createRedisClient(c.env);
  const raw = await redis.get<unknown>(getPendingKey(uid, flowId));
  if (!raw) {
    throw new ApiError(410, "ENDFIELD_BINDING_FLOW_EXPIRED", "Binding flow expired. Please exchange the token again.");
  }

  try {
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    return pendingSessionSchema.parse(payload);
  } catch {
    throw new ApiError(410, "ENDFIELD_BINDING_FLOW_INVALID", "Binding flow is invalid. Please exchange the token again.");
  }
}

function parseCachedJson<T>(raw: unknown): T {
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
}

function requireUser(c: AppContext) {
  const user = c.get("authUser");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }
  return user;
}

export function createBindingRoutes() {
  const app = new Hono<AppEnv>();

  app.use("/endfield/*", requireAuth, rateLimit("binding"));

  app.get("/endfield/status", async (c) => {
    const user = requireUser(c);
    const binding = await getBinding(c.env.DB, user.uid);
    return c.json({ binding: publicBinding(binding) });
  });

  app.post("/endfield/exchange-token", async (c) => {
    const user = requireUser(c);
    const parsed = exchangeTokenSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid exchange payload.", parsed.error.flatten());
    }

    const grant = await grantEndfieldOAuthCode(parsed.data.provider, parsed.data.token);
    const generated = await generateEndfieldCredByCode(parsed.data.provider, grant.code);
    const roles = await getEndfieldRoles(parsed.data.provider, generated.cred, generated.token);
    if (roles.length === 0) {
      throw new ApiError(404, "ENDFIELD_ROLE_NOT_FOUND", "No Endfield roles found on this account.");
    }

    const flowId = await savePendingSession(c, user.uid, {
      provider: parsed.data.provider,
      cred: generated.cred,
      token: generated.token,
      roles,
      createdAt: Date.now()
    });

    return c.json({ flowId, roles });
  });

  app.post("/endfield/exchange-code", async (c) => {
    const user = requireUser(c);
    const parsed = exchangeCodeSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid exchange payload.", parsed.error.flatten());
    }

    const generated = await generateEndfieldCredByCode(parsed.data.provider, parsed.data.code);
    const roles = await getEndfieldRoles(parsed.data.provider, generated.cred, generated.token);
    if (roles.length === 0) {
      throw new ApiError(404, "ENDFIELD_ROLE_NOT_FOUND", "No Endfield roles found on this account.");
    }

    const flowId = await savePendingSession(c, user.uid, {
      provider: parsed.data.provider,
      cred: generated.cred,
      token: generated.token,
      roles,
      createdAt: Date.now()
    });

    return c.json({ flowId, roles });
  });

  app.post("/endfield/bind-role", async (c) => {
    const user = requireUser(c);
    const parsed = bindRoleSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid role payload.", parsed.error.flatten());
    }

    const pending = await readPendingSession(c, user.uid, parsed.data.flowId);
    const role = pending.roles.find(
      (item) => item.serverId === parsed.data.serverId && item.roleId === parsed.data.roleId
    );
    if (!role) {
      throw new ApiError(404, "ENDFIELD_ROLE_NOT_FOUND", "Selected role is not available in this binding flow.");
    }

    const secret = getCredentialSecret(c);
    await saveBinding(c.env.DB, user.uid, pending.provider, role, {
      cred: await encryptSecret(pending.cred, secret),
      token: await encryptSecret(pending.token, secret)
    });

    const redis = createRedisClient(c.env);
    await redis.del(getPendingKey(user.uid, parsed.data.flowId));
    await redis.del(getPositionCacheKey(user.uid));

    const binding = await getBinding(c.env.DB, user.uid);
    return c.json({ ok: true, binding: publicBinding(binding) });
  });

  app.get("/endfield/position", async (c) => {
    const user = requireUser(c);
    const binding = await getBinding(c.env.DB, user.uid);
    if (!binding) {
      throw new ApiError(404, "ENDFIELD_BINDING_NOT_FOUND", "Endfield binding is not configured.");
    }
    if (binding.status !== "enabled") {
      throw new ApiError(409, "ENDFIELD_BINDING_DISABLED", "Endfield binding is disabled.");
    }

    const redis = createRedisClient(c.env);
    const cacheKey = getPositionCacheKey(user.uid);
    const cached = await redis.get<unknown>(cacheKey);
    if (cached) {
      return c.json(parseCachedJson(cached));
    }

    const secret = getCredentialSecret(c);
    const position = await getEndfieldPosition({
      provider: binding.provider,
      roleId: binding.role_id,
      serverId: Number(binding.server_id),
      cred: await decryptSecret(binding.cred_enc, secret),
      token: await decryptSecret(binding.token_enc, secret)
    });

    const payload = {
      data: position,
      binding: publicBinding(binding)
    };
    const ttl = getPositionCacheTtlSeconds(c.env.ENDFIELD_POSITION_CACHE_TTL_SECONDS);
    if (ttl > 0) {
      await redis.set(cacheKey, JSON.stringify(payload), { ex: ttl });
    }

    return c.json(payload);
  });

  app.post("/endfield/disable", async (c) => {
    const user = requireUser(c);
    await c.env.DB
      .prepare("UPDATE endfield_bindings SET status = 'disabled', updated_at = CURRENT_TIMESTAMP WHERE uid = ?1")
      .bind(user.uid)
      .run();
    await createRedisClient(c.env).del(getPositionCacheKey(user.uid));
    const binding = await getBinding(c.env.DB, user.uid);
    return c.json({ ok: true, binding: publicBinding(binding) });
  });

  app.post("/endfield/unlink", async (c) => {
    const user = requireUser(c);
    await c.env.DB.prepare("DELETE FROM endfield_bindings WHERE uid = ?1").bind(user.uid).run();
    await createRedisClient(c.env).del(getPositionCacheKey(user.uid));
    return c.json({ ok: true, binding: publicBinding(null) });
  });

  return app;
}
