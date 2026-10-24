import type {
  EndfieldBindingRow,
  EndfieldBindingWithDeviceProfileRow,
  EndfieldRoleDeviceProfileRow,
} from "@/repositories/binding/types";
import {
  parseEndfieldDeviceProfile,
  serializeEndfieldDeviceProfile,
} from "@/services/official/contract/deviceProfile";
import type { EndfieldDeviceProfile } from "@/services/official/contract/deviceProfile";
import type { EndfieldProvider } from "@/services/official/contract/provider";

export async function getBinding(db: D1Database, uid: string): Promise<EndfieldBindingRow | null> {
  return db
    .prepare("SELECT * FROM endfield_bindings WHERE uid = ?1 LIMIT 1")
    .bind(uid)
    .first<EndfieldBindingRow>();
}

// Return stored evidence only. Historical profile repair belongs to official/auth.
export async function getBindingWithStoredDeviceProfile(
  db: D1Database,
  uid: string,
): Promise<EndfieldBindingWithDeviceProfileRow | null> {
  return db
    .prepare(
      `SELECT b.*, p.device_profile AS role_device_profile
       FROM endfield_bindings b
       LEFT JOIN endfield_role_device_profiles p ON p.role_id = b.role_id
       WHERE b.uid = ?1
       LIMIT 1`,
    )
    .bind(uid)
    .first<EndfieldBindingWithDeviceProfileRow>();
}

export async function getRoleDeviceProfile(
  db: D1Database,
  roleId: string,
): Promise<EndfieldDeviceProfile | null> {
  const row = await db
    .prepare(
      "SELECT role_id, device_profile FROM endfield_role_device_profiles WHERE role_id = ?1 LIMIT 1",
    )
    .bind(roleId)
    .first<EndfieldRoleDeviceProfileRow>();
  return parseEndfieldDeviceProfile(row?.device_profile);
}

export async function saveRoleDeviceProfile(
  db: D1Database,
  roleId: string,
  profile: EndfieldDeviceProfile,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO endfield_role_device_profiles (role_id, device_profile, updated_at)
      VALUES (?1, ?2, CURRENT_TIMESTAMP)
      ON CONFLICT(role_id) DO UPDATE SET
        device_profile = excluded.device_profile,
        updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(roleId, serializeEndfieldDeviceProfile(profile))
    .run();
}

export async function saveBinding(
  db: D1Database,
  uid: string,
  provider: EndfieldProvider,
  role: { serverId: number; roleId: string; nickname: string; serverName: string },
  encrypted: { cred: string; token: string; accountToken?: string },
): Promise<void> {
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
        updated_at = CURRENT_TIMESTAMP`,
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
      encrypted.accountToken ?? null,
    )
    .run();
}

export async function disableBinding(db: D1Database, uid: string): Promise<void> {
  await db
    .prepare(
      "UPDATE endfield_bindings SET status = 'disabled', updated_at = CURRENT_TIMESTAMP WHERE uid = ?1",
    )
    .bind(uid)
    .run();
}

export async function deleteBinding(db: D1Database, uid: string): Promise<void> {
  await db.prepare("DELETE FROM endfield_bindings WHERE uid = ?1").bind(uid).run();
}

export async function updateBindingCredentials(
  db: D1Database,
  payload: {
    uid: string;
    binding: EndfieldBindingRow;
    credEnc: string;
    tokenEnc: string;
    deviceProfile?: EndfieldDeviceProfile;
  },
): Promise<{ updated_at: string } | null> {
  const update = db
    .prepare(
      `UPDATE endfield_bindings
      SET cred_enc = ?2, token_enc = ?3, status = 'enabled', updated_at = CURRENT_TIMESTAMP
      WHERE uid = ?1 AND cred_enc = ?4 AND token_enc = ?5
        AND provider = ?6 AND role_id = ?7 AND server_id = ?8 AND status = 'enabled'
      RETURNING updated_at`,
    )
    .bind(
      payload.uid,
      payload.credEnc,
      payload.tokenEnc,
      payload.binding.cred_enc,
      payload.binding.token_enc,
      payload.binding.provider,
      payload.binding.role_id,
      payload.binding.server_id,
    );
  if (payload.deviceProfile) {
    const [result] = await db.batch<{ updated_at: string }>([
      update,
      db
        .prepare(
          `INSERT INTO endfield_role_device_profiles (role_id, device_profile, updated_at)
         SELECT ?1, ?2, CURRENT_TIMESTAMP WHERE changes() > 0
         ON CONFLICT(role_id) DO UPDATE SET device_profile = excluded.device_profile, updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(payload.binding.role_id, serializeEndfieldDeviceProfile(payload.deviceProfile)),
    ]);
    return result.results[0] ?? null;
  }
  return update.first<{ updated_at: string }>();
}
