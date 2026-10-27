export type AuthCredentials = {
  cookie?: string;
  authorization?: string;
  // The value of the access_token query parameter.
  accessToken?: string;
};

export function resolveAuthorization(credentials: AuthCredentials): string | undefined {
  // An empty Authorization header also blocks query-token fallback.
  if (credentials.authorization !== undefined) {
    return credentials.authorization;
  }
  const accessToken = credentials.accessToken?.trim();
  return accessToken ? `Bearer ${accessToken}` : undefined;
}
