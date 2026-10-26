import type { EndfieldProvider } from "@/services/official/contract/provider";

export type BindingStatus = "enabled" | "disabled";
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

export type EndfieldBindingWithDeviceProfileRow = EndfieldBindingRow & {
  role_device_profile: string | null;
};
