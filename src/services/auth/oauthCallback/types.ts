import type { BetterAuthRequestInfo } from "@/services/auth/betterAuth";

export type OAuthCallbackInput = {
  request: BetterAuthRequestInfo;
  requestId: string;
  // Callback bodies are copied as bytes. Better Auth parses GET/POST provider responses.
  body: ArrayBuffer | null;
};
