import {
  getBindingWithStoredDeviceProfile as readStoredBindingWithDeviceProfile,
  getRoleDeviceProfile,
  saveRoleDeviceProfile,
} from "@/repositories/binding/repository";
import type { EndfieldBindingRow } from "@/repositories/binding/types";
import {
  createEndfieldDeviceId,
  createEndfieldDeviceProfile,
  SKLAND_DEVICE_PROFILE_USER_AGENT,
} from "@/services/official/client/deviceProfile";
import {
  parseEndfieldDeviceProfile,
  type EndfieldDeviceProfile,
} from "@/services/official/contract/deviceProfile";

async function getOrCreateRoleDeviceProfile(
  db: D1Database,
  roleId: string,
  fallback: EndfieldDeviceProfile | null,
): Promise<EndfieldDeviceProfile> {
  const existing = await getRoleDeviceProfile(db, roleId);
  if (existing) {
    return existing;
  }

  let profile = fallback;
  if (!profile) {
    try {
      profile = createEndfieldDeviceProfile(
        await createEndfieldDeviceId(),
        SKLAND_DEVICE_PROFILE_USER_AGENT,
      );
    } catch {
      // Historical bindings remain usable during a fingerprint-service outage.
      profile = createEndfieldDeviceProfile();
    }
  }
  await saveRoleDeviceProfile(db, roleId, profile);
  // Preserve the existing upsert/read sequence when concurrent repairs race.
  return (await getRoleDeviceProfile(db, roleId)) ?? profile;
}

export async function getBindingWithDeviceProfile(
  db: D1Database,
  uid: string,
): Promise<{ binding: EndfieldBindingRow; deviceProfile: EndfieldDeviceProfile } | null> {
  const row = await readStoredBindingWithDeviceProfile(db, uid);
  if (!row) {
    return null;
  }
  const { role_device_profile: roleDeviceProfile, ...binding } = row;
  return {
    binding,
    deviceProfile:
      parseEndfieldDeviceProfile(roleDeviceProfile) ?? (await getBindingDeviceProfile(db, binding)),
  };
}

export function getBindingDeviceProfile(
  db: D1Database,
  binding: EndfieldBindingRow,
): Promise<EndfieldDeviceProfile> {
  return getOrCreateRoleDeviceProfile(
    db,
    binding.role_id,
    parseEndfieldDeviceProfile(binding.device_profile),
  );
}
