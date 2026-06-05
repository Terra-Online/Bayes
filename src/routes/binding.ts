import { Hono, type Context } from "hono";
import { z } from "zod";
import markerHashTable from "../lib/migrate_rainbowtable.json";
import { createToken, decryptSecret, encryptSecret } from "../lib/crypto";
import {
  agreePolicy,
  connectEndfieldPositionSocket,
  createEndfieldDeviceProfile,
  generateEndfieldCredByCode,
  getEndfieldMapMarkList,
  getEndfieldPosition,
  getEndfieldRoles,
  grantEndfieldOAuthCode,
  parseEndfieldPositionSocketMessage,
  parseEndfieldPositionSocketError,
  parseEndfieldDeviceProfile,
  refreshEndfieldAuth,
  serializeEndfieldDeviceProfile,
  type EndfieldMapMarkListEnvelope,
  type EndfieldDeviceProfile,
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
  account_token_enc: string | null;
  device_profile: string | null;
  status: BindingStatus;
  updated_at: string;
};

type EndfieldRoleDeviceProfileRow = {
  role_id: string;
  device_profile: string;
};

type PendingEndfieldSession = {
  provider: EndfieldProvider;
  cred: string;
  token: string;
  accountToken?: string;
  roles: EndfieldRoleOption[];
  createdAt: number;
};

const PENDING_TTL_SECONDS = 10 * 60;
const DECRYPTED_BINDING_CACHE_TTL_MS = 180_000;
const POSITION_CACHE_FRESH_MS = 250;
const POSITION_CACHE_STALE_MS = 2_500;
const POSITION_STREAM_RECONNECT_MS = 1_000;

type DecryptedBinding = {
  binding: EndfieldBindingRow;
  publicBinding: ReturnType<typeof publicBinding>;
  cred: string;
  token: string;
  accountToken?: string;
  wsBaseUrl?: string;
  deviceProfile: EndfieldDeviceProfile;
};

type DecryptedBindingCacheEntry = DecryptedBinding & {
  expiresAt: number;
};

type PositionCacheEntry = {
  data: Awaited<ReturnType<typeof getEndfieldPosition>>;
  refreshedAt: number;
};

type OfficialMapMark = {
  id: string;
  isUserMarked: boolean;
};

type OfficialMarksResult = {
  raw: Record<"map01" | "map02", EndfieldMapMarkListEnvelope>;
  markers: OfficialMapMark[];
};

const decryptedBindingCache = new Map<string, DecryptedBindingCacheEntry>();
const positionCache = new Map<string, PositionCacheEntry>();
const positionRefreshInFlight = new Map<string, Promise<PositionCacheEntry>>();
const MARKER_HASH_TO_POINT_ID = markerHashTable as Record<string, string>;

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
  accountToken: z.string().optional(),
  roles: z.array(roleOptionSchema),
  createdAt: z.number()
});

function isMissingColumnError(error: unknown, column: string): boolean {
  return error instanceof Error && error.message.toLowerCase().includes(column.toLowerCase());
}

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
  try {
    return await db
      .prepare("SELECT * FROM endfield_bindings WHERE uid = ?1 LIMIT 1")
      .bind(uid)
      .first<EndfieldBindingRow>();
  } catch (error) {
    if (!isMissingColumnError(error, "account_token_enc")) {
      throw error;
    }
    const row = await db
      .prepare(
        `SELECT uid, provider, server_id, role_id, role_nickname, server_name, cred_enc, token_enc,
          NULL AS account_token_enc, device_profile, status, updated_at
        FROM endfield_bindings WHERE uid = ?1 LIMIT 1`
      )
      .bind(uid)
      .first<EndfieldBindingRow>();
    return row;
  }
}

async function getRoleDeviceProfile(db: D1Database, roleId: string): Promise<EndfieldDeviceProfile | null> {
  const row = await db
    .prepare("SELECT role_id, device_profile FROM endfield_role_device_profiles WHERE role_id = ?1 LIMIT 1")
    .bind(roleId)
    .first<EndfieldRoleDeviceProfileRow>();
  return parseEndfieldDeviceProfile(row?.device_profile);
}

async function getOrCreateRoleDeviceProfile(
  db: D1Database,
  roleId: string,
  fallback?: EndfieldDeviceProfile | null
): Promise<EndfieldDeviceProfile> {
  const existing = await getRoleDeviceProfile(db, roleId);
  if (existing) return existing;

  const profile = fallback ?? createEndfieldDeviceProfile();
  await db
    .prepare(
      `INSERT INTO endfield_role_device_profiles (role_id, device_profile, updated_at)
      VALUES (?1, ?2, CURRENT_TIMESTAMP)
      ON CONFLICT(role_id) DO NOTHING`
    )
    .bind(roleId, serializeEndfieldDeviceProfile(profile))
    .run();

  return await getRoleDeviceProfile(db, roleId) ?? profile;
}

async function getBindingDeviceProfile(
  db: D1Database,
  binding?: EndfieldBindingRow | null
): Promise<EndfieldDeviceProfile> {
  if (!binding) {
    return createEndfieldDeviceProfile();
  }
  return getOrCreateRoleDeviceProfile(
    db,
    binding.role_id,
    parseEndfieldDeviceProfile(binding.device_profile)
  );
}

function deleteLocatorCaches(uid: string): void {
  decryptedBindingCache.delete(uid);
  for (const key of positionCache.keys()) {
    if (key.startsWith(`${uid}:`)) {
      positionCache.delete(key);
    }
  }
  for (const key of positionRefreshInFlight.keys()) {
    if (key.startsWith(`${uid}:`)) {
      positionRefreshInFlight.delete(key);
    }
  }
}

async function getDecryptedBinding(c: AppContext, uid: string): Promise<DecryptedBinding> {
  const now = Date.now();
  const cached = decryptedBindingCache.get(uid);
  if (cached && cached.expiresAt > now) {
    return cached;
  }

  const binding = await getBinding(c.env.DB, uid);
  if (!binding) {
    throw new ApiError(404, "ENDFIELD_BINDING_NOT_FOUND", "Endfield binding is not configured.");
  }
  if (binding.status !== "enabled") {
    throw new ApiError(409, "ENDFIELD_BINDING_DISABLED", "Endfield binding is disabled.");
  }
  const deviceProfile = await getBindingDeviceProfile(c.env.DB, binding);

  const secret = getCredentialSecret(c);
  const [cred, token, accountToken] = await Promise.all([
    decryptSecret(binding.cred_enc, secret),
    decryptSecret(binding.token_enc, secret),
    binding.account_token_enc
      ? decryptSecret(binding.account_token_enc, secret).catch(() => undefined)
      : undefined
  ]);

  const decrypted: DecryptedBindingCacheEntry = {
    binding,
    publicBinding: publicBinding(binding),
    cred,
    token,
    accountToken,
    wsBaseUrl: c.env.ENDFIELD_WS_BASE_URL,
    deviceProfile,
    expiresAt: now + DECRYPTED_BINDING_CACHE_TTL_MS
  };
  decryptedBindingCache.set(uid, decrypted);
  return decrypted;
}

function isAutoRefreshableEndfieldError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const details = error.details as { upstreamCode?: unknown; upstreamStatus?: unknown } | undefined;
  const upstreamCode = Number(details?.upstreamCode);
  return error.code === "ENDFIELD_CREDENTIAL_REJECTED"
    || error.code === "ENDFIELD_POSITION_SOCKET_UNAVAILABLE"
    || details?.upstreamStatus === 401
    || details?.upstreamStatus === 403
    || upstreamCode === 10000;
}

async function updateStoredCredential(
  c: AppContext,
  uid: string,
  generated: { cred: string; token: string }
): Promise<void> {
  const secret = getCredentialSecret(c);
  await c.env.DB
    .prepare(
      `UPDATE endfield_bindings
      SET cred_enc = ?2, token_enc = ?3, status = 'enabled', updated_at = CURRENT_TIMESTAMP
      WHERE uid = ?1`
    )
    .bind(
      uid,
      await encryptSecret(generated.cred, secret),
      await encryptSecret(generated.token, secret)
    )
    .run();
  deleteLocatorCaches(uid);
}

async function refreshBindingCredentials(
  c: AppContext,
  uid: string,
  binding: DecryptedBinding
): Promise<DecryptedBinding | null> {
  if (binding.accountToken) {
    try {
      const grant = await grantEndfieldOAuthCode(
        binding.binding.provider,
        binding.accountToken,
        binding.deviceProfile
      );
      const generated = await generateEndfieldCredByCode(
        binding.binding.provider,
        grant.code,
        binding.deviceProfile
      );
      await updateStoredCredential(c, uid, generated);
      return getDecryptedBinding(c, uid);
    } catch {
      // Fall through to the lightweight refresh endpoint before forcing a rebind.
    }
  }

  const refreshed = await refreshEndfieldAuth({
    provider: binding.binding.provider,
    cred: binding.cred,
    deviceProfile: binding.deviceProfile
  });
  await updateStoredCredential(c, uid, {
    cred: refreshed.cred ?? binding.cred,
    token: refreshed.token!
  });
  return getDecryptedBinding(c, uid);
}

async function withAutoRefreshedBinding<T>(
  c: AppContext,
  uid: string,
  operation: (binding: DecryptedBinding) => Promise<T>
): Promise<T> {
  const binding = await getDecryptedBinding(c, uid);
  try {
    return await operation(binding);
  } catch (error) {
    if (!isAutoRefreshableEndfieldError(error)) {
      throw error;
    }
    const refreshed = await refreshBindingCredentials(c, uid, binding);
    if (!refreshed) {
      throw error;
    }
    return operation(refreshed);
  }
}

function getPositionCacheKey(uid: string, binding: EndfieldBindingRow): string {
  return [
    uid,
    binding.provider,
    binding.server_id,
    binding.role_id,
    binding.updated_at
  ].join(":");
}

async function refreshPositionCache(key: string, binding: DecryptedBinding): Promise<PositionCacheEntry> {
  const inFlight = positionRefreshInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = getEndfieldPosition({
    provider: binding.binding.provider,
    roleId: binding.binding.role_id,
    serverId: Number(binding.binding.server_id),
    cred: binding.cred,
    token: binding.token,
    wsBaseUrl: binding.wsBaseUrl,
    deviceProfile: binding.deviceProfile
  })
    .then((data) => {
      const entry = {
        data,
        refreshedAt: Date.now()
      };
      positionCache.set(key, entry);
      return entry;
    })
    .finally(() => {
      positionRefreshInFlight.delete(key);
    });

  positionRefreshInFlight.set(key, promise);
  return promise;
}

function collectOfficialMarkers(value: unknown, output: OfficialMapMark[] = []): OfficialMapMark[] {
  if (!value || typeof value !== "object") {
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectOfficialMarkers(item, output);
    }
    return output;
  }

  const record = value as Record<string, unknown>;
  const candidate = record.marker && typeof record.marker === "object"
    ? record.marker as Record<string, unknown>
    : record;
  if (
    (typeof candidate.id === "string" || typeof candidate.id === "number")
    && typeof candidate.isUserMarked === "boolean"
  ) {
    output.push({
      id: String(candidate.id),
      isUserMarked: candidate.isUserMarked
    });
    if (candidate !== record) {
      return output;
    }
  }

  for (const item of Object.values(record)) {
    collectOfficialMarkers(item, output);
  }
  return output;
}

async function getOfficialMarks(binding: DecryptedBinding): Promise<OfficialMarksResult> {
  const [map01, map02] = await Promise.all([
    getEndfieldMapMarkList({
      provider: binding.binding.provider,
      roleId: binding.binding.role_id,
      serverId: Number(binding.binding.server_id),
      mapId: "map01",
      cred: binding.cred,
      token: binding.token,
      deviceProfile: binding.deviceProfile
    }),
    getEndfieldMapMarkList({
      provider: binding.binding.provider,
      roleId: binding.binding.role_id,
      serverId: Number(binding.binding.server_id),
      mapId: "map02",
      cred: binding.cred,
      token: binding.token,
      deviceProfile: binding.deviceProfile
    })
  ]);

  const raw = { map01, map02 };
  return {
    raw,
    markers: collectOfficialMarkers(raw)
  };
}

function schedulePositionRefresh(c: AppContext, key: string, binding: DecryptedBinding): void {
  const refresh = refreshPositionCache(key, binding).catch(() => undefined);
  c.executionCtx.waitUntil(refresh);
}

function serializeLocatorError(error: unknown) {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details
    };
  }

  return {
    status: 500,
    code: "LOCATOR_STREAM_ERROR",
    message: error instanceof Error ? error.message : "Locator stream failed."
  };
}

async function handleEndfieldPositionSocket(c: AppContext) {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw new ApiError(426, "WEBSOCKET_REQUIRED", "Use a WebSocket connection for this endpoint.");
  }

  const user = requireUser(c);
  const includeBinding = shouldIncludeBinding(c);
  let binding = await getDecryptedBinding(c, user.uid);
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  let closed = false;
  let upstream: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let upstreamGeneration = 0;

  const close = () => {
    closed = true;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    try {
      upstream?.close(1000, "client closed");
    } catch {
      // upstream is already closed
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== undefined) return;
    try {
      upstream?.close(1000, "reconnecting");
    } catch {
      // upstream is already closed
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void bridgeUpstream();
    }, POSITION_STREAM_RECONNECT_MS);
  };

  const sendJson = (payload: unknown) => {
    if (closed) return;
    try {
      server.send(JSON.stringify(payload));
    } catch {
      close();
    }
  };

  const bridgeUpstream = async () => {
    const generation = upstreamGeneration + 1;
    upstreamGeneration = generation;
    try {
      sendJson({
        type: "status",
        status: "connecting"
      });
      upstream = await connectEndfieldPositionSocket({
        provider: binding.binding.provider,
        roleId: binding.binding.role_id,
        serverId: Number(binding.binding.server_id),
        cred: binding.cred,
        token: binding.token,
        wsBaseUrl: c.env.ENDFIELD_WS_BASE_URL,
        deviceProfile: binding.deviceProfile
      });
      sendJson({
        type: "status",
        status: "connected"
      });

      upstream.addEventListener("message", (event) => {
        if (generation !== upstreamGeneration) return;
        const error = parseEndfieldPositionSocketError(event.data as string | ArrayBuffer);
        if (error?.code === 10000) {
          sendJson({
            type: "error",
            error: {
              status: 401,
              code: "ENDFIELD_CREDENTIAL_REJECTED",
              message: error.message ?? "Endfield credential was rejected.",
              details: {
                upstreamCode: error.code,
                upstreamMessage: error.message
              }
            }
          });
          return;
        }

        const position = parseEndfieldPositionSocketMessage(event.data as string | ArrayBuffer);
        if (!position) return;
        positionCache.set(getPositionCacheKey(user.uid, binding.binding), {
          data: position,
          refreshedAt: Date.now()
        });
        sendJson({
          type: "position",
          data: position,
          ...(includeBinding ? { binding: binding.publicBinding } : {})
        });
      });
      upstream.addEventListener("close", () => {
        if (!closed && generation === upstreamGeneration) {
          upstreamGeneration += 1;
          sendJson({
            type: "status",
            status: "reconnecting",
            reason: "upstream closed"
          });
          scheduleReconnect();
        }
      });
      upstream.addEventListener("error", () => {
        if (!closed && generation === upstreamGeneration) {
          upstreamGeneration += 1;
          sendJson({
            type: "status",
            status: "reconnecting",
            reason: "upstream error"
          });
          scheduleReconnect();
        }
      });
    } catch (error) {
      if (isAutoRefreshableEndfieldError(error)) {
        const refreshed = await refreshBindingCredentials(c, user.uid, binding).catch(() => null);
        if (refreshed && !closed) {
          binding = refreshed;
          scheduleReconnect();
          return;
        }
      }
      sendJson({
        type: "error",
        error: serializeLocatorError(error)
      });
      scheduleReconnect();
    }
  };

  server.accept();
  server.addEventListener("close", close);
  server.addEventListener("error", close);
  server.addEventListener("message", (event) => {
    if (event.data === "close") {
      server.close(1000, "closed");
      close();
    }
  });

  c.executionCtx.waitUntil(bridgeUpstream());

  return new Response(null, {
    status: 101,
    webSocket: client
  });
}

async function saveBinding(
  db: D1Database,
  uid: string,
  provider: EndfieldProvider,
  role: EndfieldRoleOption,
  encrypted: { cred: string; token: string; accountToken?: string }
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO endfield_bindings (
          uid, provider, server_id, role_id, role_nickname, server_name, cred_enc, token_enc, account_token_enc, status, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'enabled', CURRENT_TIMESTAMP)
        ON CONFLICT(uid) DO UPDATE SET
          provider = excluded.provider,
          server_id = excluded.server_id,
          role_id = excluded.role_id,
          role_nickname = excluded.role_nickname,
          server_name = excluded.server_name,
          cred_enc = excluded.cred_enc,
          token_enc = excluded.token_enc,
          account_token_enc = excluded.account_token_enc,
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
        encrypted.token,
        encrypted.accountToken ?? null
      )
      .run();
  } catch (error) {
    if (!isMissingColumnError(error, "account_token_enc")) {
      throw error;
    }
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
  const includeBinding = shouldIncludeBinding(c);
  return withAutoRefreshedBinding(c, user.uid, async (binding) => {
    const cacheKey = getPositionCacheKey(user.uid, binding.binding);
    const cached = positionCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.refreshedAt <= POSITION_CACHE_STALE_MS) {
      if (now - cached.refreshedAt > POSITION_CACHE_FRESH_MS) {
        schedulePositionRefresh(c, cacheKey, binding);
      }

      const response = c.json({
        data: cached.data,
        ...(includeBinding ? { binding: binding.publicBinding } : {})
      });
      response.headers.set("cache-control", "private, no-store");
      response.headers.set("x-locator-cache", now - cached.refreshedAt <= POSITION_CACHE_FRESH_MS ? "fresh" : "stale");
      response.headers.set("x-locator-age-ms", String(now - cached.refreshedAt));
      return response;
    }

    const position = await refreshPositionCache(cacheKey, binding);

    const response = c.json({
      data: position.data,
      ...(includeBinding ? { binding: binding.publicBinding } : {})
    });
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("x-locator-cache", "miss");
    response.headers.set("x-locator-age-ms", "0");
    return response;
  });
}

async function handleOfficialMarks(c: AppContext) {
  const user = requireUser(c);
  return withAutoRefreshedBinding(c, user.uid, async (binding) => {
    const result = await getOfficialMarks(binding);
    const markedIds = [...new Set(result.markers
      .filter((marker) => marker.isUserMarked)
      .map((marker) => marker.id))];
    const pointIds = [...new Set(markedIds
      .map((id) => MARKER_HASH_TO_POINT_ID[id.toLowerCase()])
      .filter((id): id is string => Boolean(id)))];
    const response = c.json({
      binding: binding.publicBinding,
      timestamp: new Date().toISOString(),
      markedIds,
      pointIds,
      markers: result.markers,
      raw: result.raw
    });
    response.headers.set("cache-control", "private, no-store");
    return response;
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
    token: await decryptSecret(binding.token_enc, secret),
    deviceProfile: await getBindingDeviceProfile(c.env.DB, binding)
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
    const payload = await c.req.json().catch(() => undefined);
    const parsed = exchangeTokenSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid exchange payload.", parsed.error.flatten());
    }

    try {
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
        accountToken: parsed.data.token,
        roles,
        createdAt: Date.now()
      });

      return c.json({ flowId, roles });
    } catch (error) {
      if (error instanceof ApiError) {
        console.warn("[binding][endfield][exchange-token] failed", {
          requestId: c.get("requestId"),
          provider: parsed.data.provider,
          code: error.code,
          status: error.status,
          details: error.details,
        });
      }
      throw error;
    }
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
    await getOrCreateRoleDeviceProfile(c.env.DB, role.roleId);
    await saveBinding(c.env.DB, user.uid, pending.provider, role, {
      cred: await encryptSecret(pending.cred, secret),
      token: await encryptSecret(pending.token, secret),
      accountToken: pending.accountToken ? await encryptSecret(pending.accountToken, secret) : undefined
    });
    deleteLocatorCaches(user.uid);

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
    deleteLocatorCaches(user.uid);
    const binding = await getBinding(c.env.DB, user.uid);
    return c.json({ ok: true, binding: publicBinding(binding) });
  });

  app.post("/endfield/unlink", async (c) => {
    const user = requireUser(c);
    await c.env.DB.prepare("DELETE FROM endfield_bindings WHERE uid = ?1").bind(user.uid).run();
    deleteLocatorCaches(user.uid);
    return c.json({ ok: true, binding: publicBinding(null) });
  });

  return app;
}

export function createLocatorRoutes() {
  const app = new Hono<AppEnv>();

  app.use("/*", requireAuth);
  app.get("/position", handleEndfieldPosition);
  app.get("/position-stream", handleEndfieldPositionSocket);
  app.post("/agree-policy", handleAgree);

  return app;
}

export function createSyncRoutes() {
  const app = new Hono<AppEnv>();

  app.use("/*", requireAuth);
  app.get("/official", handleOfficialMarks);

  return app;
}
