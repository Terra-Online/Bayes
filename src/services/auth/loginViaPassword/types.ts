export type LoginViaPasswordInput = {
  // The route parses JSON first. The adapter reads only this request's URL and headers.
  raw_request: Request;
  requestId: string;
  // This invocation owns the parsed object. Email normalization updates it in place.
  // Better Auth validates the fields and retains its public validation errors.
  payload: Record<string, unknown>;
};
