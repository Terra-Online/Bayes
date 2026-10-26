export function getRequestAuthHeaders(request: Request): Headers {
  const accessToken = new URL(request.url).searchParams.get("access_token")?.trim();
  if (!accessToken || request.headers.has("authorization")) {
    return request.headers;
  }

  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  return headers;
}
