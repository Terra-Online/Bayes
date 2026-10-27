import type { AuthUser } from "@/types/app";

export type CreateSessionExchangeCodeInput = {
  sessionToken: string;
  origin: string;
  challenge: string;
};

export type ExchangeSessionInput = {
  code: string;
  origin: string;
  cookie?: string;
  userAgent?: string;
  requestId: string;
};

export type ExchangeSessionResult = {
  user: AuthUser;
  cookies: string[];
};
