import type { BetterAuthRequestInfo } from "@/lib/auth/betterAuth";

export type PasswordResetContext = {
  request: BetterAuthRequestInfo;
  requestId: string;
};

export type RequestPasswordResetInput = PasswordResetContext & {
  email: string;
  redirectTo: string;
  locale?: string;
};

export type ResetPasswordInput = PasswordResetContext & {
  token: string;
  newPassword: string;
  repeatPassword: string;
};

export type PasswordResetPreview = {
  ok: true;
  tokenValid: true;
  email: string;
};
