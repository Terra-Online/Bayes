import type { AuthCredentials } from "./contract/credentials";

export function getRequestAuthCredentials(request: Request): AuthCredentials {
  return {
    cookie: request.headers.get("cookie") ?? undefined,
    authorization: request.headers.get("authorization") ?? undefined,
    accessToken: new URL(request.url).searchParams.get("access_token") ?? undefined,
  };
}
