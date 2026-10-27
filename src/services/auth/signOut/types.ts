import type { BetterAuthRequestInfo } from "@/services/auth/betterAuth";

export type SignOutInput = {
  request: BetterAuthRequestInfo;
  requestId: string;
  // Better Auth parses these bytes according to the incoming content type.
  // null represents a request without a body.
  body: ArrayBuffer | null;
};
