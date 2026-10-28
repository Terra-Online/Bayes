export type BeginSocialLoginInput = {
  // The route parses JSON first. The adapter reads only this request's URL and headers.
  raw_request: Request;
  requestId: string;
  // Better Auth validates provider-specific options. The adapter forwards them unchanged.
  payload: Record<string, unknown>;
};
