import type { AuthCredentials } from "./contract/credentials";

// Extract original values without injecting headers or changing the request.
export function getRequestAuthCredentials(raw_request: Request): AuthCredentials {
  return {
    cookie: raw_request.headers.get("cookie") ?? undefined,
    authorization: raw_request.headers.get("authorization") ?? undefined,
    accessToken: new URL(raw_request.url).searchParams.get("access_token") ?? undefined,
  };
}
