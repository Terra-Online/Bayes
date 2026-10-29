type LoginMethodContext = {
  // The route parses JSON first. This module reads only this request's URL and headers.
  raw_request: Request;
  requestId: string;
};

export type CurrentLoginMethodUser = {
  // Hono supplies authUser.uid, the business profile's internal ID.
  // Historical profiles can have a different ID from the Better Auth user.
  currentUserId: string;
};

export type BeginLinkLoginMethodInput = LoginMethodContext & {
  provider: "google" | "discord" | "github";
  callbackURL?: string;
  errorCallbackURL?: string;
  disableRedirect?: boolean;
};

export type UnlinkLoginMethodInput = LoginMethodContext &
  CurrentLoginMethodUser & {
    provider: "email" | "google" | "discord" | "github";
  };

export type LoginMethod = {
  // Stored providers pass through unchanged, except credential becomes email.
  provider: string;
  linkedAt: string;
  verified?: boolean;
  unlinkable: boolean;
};
