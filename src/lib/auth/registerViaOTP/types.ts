import type { BetterAuthRequestInfo } from "@/lib/auth/betterAuth";

type RegistrationContext = {
  request: BetterAuthRequestInfo;
  requestId: string;
};

export type RequestRegistrationOtpInput = RegistrationContext & {
  email: string;
  locale?: string;
};

export type RegisterViaOTPInput = RegistrationContext & {
  email: string;
  otp: string;
  password: string;
  name?: string;
};
