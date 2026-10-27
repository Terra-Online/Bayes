import type { BetterAuthRequestInfo } from "@/services/auth/betterAuth";

export type BeginSocialLoginInput = {
  request: BetterAuthRequestInfo;
  requestId: string;
  // Better Auth validates provider-specific options. The adapter forwards them unchanged.
  payload: Record<string, unknown>;
};
