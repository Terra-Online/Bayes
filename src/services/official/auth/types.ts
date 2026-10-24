import type { EndfieldBindingRow } from "@/repositories/binding/types";
import type { EndfieldRoleOption } from "@/services/official/client/types";
import type { EndfieldDeviceProfile } from "@/services/official/contract/deviceProfile";
import type { EndfieldProvider } from "@/services/official/contract/provider";

import type { publicBinding } from "./publicBinding";

export type PendingEndfieldSession = {
  provider: EndfieldProvider;
  deviceProfile?: EndfieldDeviceProfile;
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
