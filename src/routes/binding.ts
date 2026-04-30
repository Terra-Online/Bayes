import { Hono, type Context } from "hono";
import { z } from "zod";
import { createToken, decryptSecret, encryptSecret } from "../lib/crypto";
import {
  agreePolicy,
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
const agreeSchema = z.object({
  serverId: z.union([z.number().int().positive(), z.string().trim().min(1).max(64)]).optional(),
  roleId: z.string().trim().min(1).max(128).optional()
}).optional();
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

function getPendingKey(uid: string, flowId: string): string {
  return `binding:endfield:pending:${uid}:${flowId}`;
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

function shouldIncludeBinding(c: AppContext): boolean {
  const value = c.req.query("binding") ?? c.req.query("includeBinding");
  return value === "1" || value === "true";
}

function requireUser(c: AppContext) {
  const user = c.get("authUser");
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
  }
  return user;
}

async function handleEndfieldPosition(c: AppContext) {
  const user = requireUser(c);
  const binding = await getBinding(c.env.DB, user.uid);
  if (!binding) {
    throw new ApiError(404, "ENDFIELD_BINDING_NOT_FOUND", "Endfield binding is not configured.");
  }
  if (binding.status !== "enabled") {
    throw new ApiError(409, "ENDFIELD_BINDING_DISABLED", "Endfield binding is disabled.");
  }

  const includeBinding = shouldIncludeBinding(c);

  const secret = getCredentialSecret(c);
  const position = await getEndfieldPosition({
    provider: binding.provider,
    roleId: binding.role_id,
    serverId: Number(binding.server_id),
    cred: await decryptSecret(binding.cred_enc, secret),
    token: await decryptSecret(binding.token_enc, secret)
  });

  return c.json({
    data: position,
    ...(includeBinding ? { binding: publicBinding(binding) } : {})
  });
}

async function handleAgree(c: AppContext) {
  const user = requireUser(c);
  const binding = await getBinding(c.env.DB, user.uid);
  if (!binding) {
    throw new ApiError(404, "ENDFIELD_BINDING_NOT_FOUND", "Endfield binding is not configured.");
  }
  if (binding.status !== "enabled") {
    throw new ApiError(409, "ENDFIELD_BINDING_DISABLED", "Endfield binding is disabled.");
  }

  const payload = await c.req.json().catch(() => undefined);
  const parsed = agreeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid agree-policy payload.", parsed.error.flatten());
  }

  const reqRole = parsed.data?.roleId;
  const reqServer = parsed.data?.serverId;
  if (
    (reqRole && reqRole !== binding.role_id)
    || (reqServer !== undefined && Number(reqServer) !== Number(binding.server_id))
  ) {
    throw new ApiError(409, "ENDFIELD_BINDING_MISMATCH", "Policy authorization target does not match the current Endfield binding.");
  }

  const secret = getCredentialSecret(c);
  await agreePolicy({
    provider: binding.provider,
    roleId: binding.role_id,
    serverId: Number(binding.server_id),
    cred: await decryptSecret(binding.cred_enc, secret),
    token: await decryptSecret(binding.token_enc, secret)
  });

  return c.json({ ok: true, binding: publicBinding(binding) });
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

    const binding = await getBinding(c.env.DB, user.uid);
    return c.json({ ok: true, binding: publicBinding(binding) });
  });

  app.post("/endfield/disable", async (c) => {
    const user = requireUser(c);
    await c.env.DB
      .prepare("UPDATE endfield_bindings SET status = 'disabled', updated_at = CURRENT_TIMESTAMP WHERE uid = ?1")
      .bind(user.uid)
      .run();
    const binding = await getBinding(c.env.DB, user.uid);
    return c.json({ ok: true, binding: publicBinding(binding) });
  });

  app.post("/endfield/unlink", async (c) => {
    const user = requireUser(c);
    await c.env.DB.prepare("DELETE FROM endfield_bindings WHERE uid = ?1").bind(user.uid).run();
    return c.json({ ok: true, binding: publicBinding(null) });
  });

  return app;
}

export function createLocatorRoutes() {
  const app = new Hono<AppEnv>();

  app.use("/*", requireAuth);
  app.get("/position", handleEndfieldPosition);
  app.post("/agree-policy", handleAgree);

  return app;
}
