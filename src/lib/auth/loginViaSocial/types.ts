import type { BetterAuthRequestInfo } from "@/lib/auth/betterAuth";

export type BeginSocialLoginInput = {
  request: BetterAuthRequestInfo;
  requestId: string;
  // Better Auth validates provider-specific options. The adapter forwards them unchanged.
  payload: Record<string, unknown>;
};
