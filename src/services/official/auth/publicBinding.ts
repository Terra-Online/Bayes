import type { EndfieldBindingRow } from "@/repositories/binding/types";

export function publicBinding(row: EndfieldBindingRow | null) {
  if (!row) {
    return {
      bound: false,
      enabled: false,
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
    updatedAt: row.updated_at,
  };
}
