import type {
  EndfieldDeviceProfile,
  EndfieldProvider,
  EndfieldRoleOption,
} from "@/lib/endfieldClient/types";
import type { publicBinding } from "@/repositories/binding/repository";
import type { EndfieldBindingRow } from "@/repositories/binding/types";

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

export type DecryptedBindingCacheEntry = DecryptedBinding & {
  expiresAt: number;
};
