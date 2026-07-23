import { createEndfieldDeviceProfile, parseEndfieldDeviceProfile, serializeEndfieldDeviceProfile } from "../../lib/endfieldClient/deviceProfile";
import type { EndfieldDeviceProfile, EndfieldProvider, EndfieldRoleOption } from "../../lib/endfieldClient/types";
import type {
  EndfieldBindingRow,
  EndfieldBindingWithDeviceProfileRow,
  EndfieldRoleDeviceProfileRow
} from "./types";

export function isMissingColumnError(error: unknown, column: string): boolean {
  return error instanceof Error && error.message.toLowerCase().includes(column.toLowerCase());
}

export function publicBinding(row: EndfieldBindingRow | null) {
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

export async function getBinding(db: D1Database, uid: string): Promise<EndfieldBindingRow | null> {
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

export async function getBindingWithDeviceProfile(
  db: D1Database,
  uid: string
): Promise<{ binding: EndfieldBindingRow; deviceProfile: EndfieldDeviceProfile } | null> {
  const row = await db
    .prepare(
      `SELECT b.*, p.device_profile AS role_device_profile
       FROM endfield_bindings b
       LEFT JOIN endfield_role_device_profiles p ON p.role_id = b.role_id
       WHERE b.uid = ?1
       LIMIT 1`
    )
    .bind(uid)
    .first<EndfieldBindingWithDeviceProfileRow>();
  if (!row) return null;

  const { role_device_profile: roleDeviceProfile, ...binding } = row;
  const parsedRoleProfile = parseEndfieldDeviceProfile(roleDeviceProfile);
  return {
    binding,
    deviceProfile: parsedRoleProfile ?? await getOrCreateRoleDeviceProfile(
      db,
      binding.role_id,
      parseEndfieldDeviceProfile(binding.device_profile)
    )
  };
}

export async function getRoleDeviceProfile(db: D1Database, roleId: string): Promise<EndfieldDeviceProfile | null> {
  const row = await db
    .prepare("SELECT role_id, device_profile FROM endfield_role_device_profiles WHERE role_id = ?1 LIMIT 1")
    .bind(roleId)
    .first<EndfieldRoleDeviceProfileRow>();
  return parseEndfieldDeviceProfile(row?.device_profile);
}

export async function getOrCreateRoleDeviceProfile(
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

export async function getBindingDeviceProfile(
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

export async function saveBinding(
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

export async function disableBinding(db: D1Database, uid: string): Promise<void> {
  await db
    .prepare("UPDATE endfield_bindings SET status = 'disabled', updated_at = CURRENT_TIMESTAMP WHERE uid = ?1")
    .bind(uid)
    .run();
}

export async function deleteBinding(db: D1Database, uid: string): Promise<void> {
  await db.prepare("DELETE FROM endfield_bindings WHERE uid = ?1").bind(uid).run();
}
