export type OAuthCallbackInput = {
  // The HTTP entrypoint must leave this body unread. Better Auth consumes its stream.
  raw_request: Request;
  requestId: string;
};
