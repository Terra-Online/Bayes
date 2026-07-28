const TEST_UPLOAD_PREFIX = "_test";
const BETA_FRONTEND_HOSTNAMES = new Set([
  "beta.opendfieldmap.org"
]);

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isBetaFrontendRequest(request: Request): boolean {
  const candidates = [request.headers.get("origin"), request.headers.get("referer")];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      const url = new URL(candidate);
      if (BETA_FRONTEND_HOSTNAMES.has(url.hostname.toLowerCase())) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

export function resolveUploadPrefix(request: Request, configuredPrefix: string): string {
  if (isBetaFrontendRequest(request)) {
    return TEST_UPLOAD_PREFIX;
  }
  return configuredPrefix;
}

export function resolveImageScope(
  request: Request,
  configuredPrefix: string,
  scope: "test" | "prod" | undefined
): { pathPrefix?: string; excludePathPrefix?: string } {
  if (new URL(request.url).searchParams.get("demoLocal") === "1") {
    return { excludePathPrefix: TEST_UPLOAD_PREFIX };
  }
  if (isBetaFrontendRequest(request) || configuredPrefix === TEST_UPLOAD_PREFIX) {
    return { pathPrefix: TEST_UPLOAD_PREFIX };
  }

  if (scope === "test") {
    return { pathPrefix: TEST_UPLOAD_PREFIX };
  }

  if (scope === "prod") {
    return { excludePathPrefix: TEST_UPLOAD_PREFIX };
  }

  return {};
}

export function resolvePublicAssetBaseUrl(requestUrl: string, configuredBaseUrl: string): string {
  const url = new URL(requestUrl);
  if (isLocalHostname(url.hostname)) {
    return `${url.origin}/uploads/v1/public-file`;
  }
  return configuredBaseUrl;
}

export function resolvePrivateAssetBaseUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  return `${url.origin}/uploads/v1/file`;
}
