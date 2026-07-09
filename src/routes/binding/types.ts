import type { Context } from "hono";
import type { EndfieldDeviceProfile, EndfieldMapMarkListEnvelope, EndfieldProvider, EndfieldRoleOption } from "../../lib/endfieldClient/types";
import type { AppEnv } from "../../types/app";
import type { publicBinding } from "./repository";
import type { getEndfieldPosition } from "../../lib/endfieldClient/positionSocket";

export type BindingStatus = "enabled" | "disabled";
export type AppContext = Context<AppEnv>;

export type EndfieldBindingRow = {
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

export type EndfieldRoleDeviceProfileRow = {
  role_id: string;
  device_profile: string;
};

export type PendingEndfieldSession = {
  provider: EndfieldProvider;
  cred: string;
  token: string;
  accountToken?: string;
  roles: EndfieldRoleOption[];
  createdAt: number;
};

export type DecryptedBinding = {
  binding: EndfieldBindingRow;
  publicBinding: ReturnType<typeof publicBinding>;
  cred: string;
  token: string;
  accountToken?: string;
  wsBaseUrl?: string;
  deviceProfile: EndfieldDeviceProfile;
};

export type DecryptedBindingCacheEntry = DecryptedBinding & {
  expiresAt: number;
};

export type PositionCacheEntry = {
  data: Awaited<ReturnType<typeof getEndfieldPosition>>;
  refreshedAt: number;
};

export type OfficialMapMark = {
  id: string;
  isUserMarked: boolean;
};

export type OfficialMarksResult = {
  raw: Record<"map01" | "map02", EndfieldMapMarkListEnvelope>;
  markers: OfficialMapMark[];
};
