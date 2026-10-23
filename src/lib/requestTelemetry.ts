type HttpEntrypoint = "default" | "PublicReadCache";

/** Log response readiness, not stream completion, socket lifetime, or waitUntil work. */
export async function withRequestTelemetry(
  request: Request,
  entrypoint: HttpEntrypoint,
  handle: () => Response | Promise<Response>,
): Promise<Response> {
  const startedAtMs = Date.now();
  let response: Response | undefined;
  try {
    response = await handle();
    return response;
  } finally {
    const url = new URL(request.url);
    const internal = entrypoint === "PublicReadCache";
    const cf = request.cf;
    // Only edge-provided metadata describes a client; internal cache reads are not visitors.
    let source = cf ? "edge" : "unknown";
    if (internal) {
      source = "internal";
    }
    // eslint-disable-next-line no-console -- Structured request data is intentionally exported by Logpush.
    console.log({
      event: "oem.request",
      schemaVersion: 1,
      entrypoint,
      source,
      startedAtMs,
      method: request.method,
      host: url.hostname,
      path: url.pathname,
      protocol:
        request.headers.get("upgrade")?.toLowerCase() === "websocket" ? "websocket" : "http",
      status: response?.status ?? null,
      result: response ? "response" : "threw",
      responseReadyMs: Math.max(0, Date.now() - startedAtMs),
      rayId: request.headers.get("cf-ray"),
      requestId: response?.headers.get("x-request-id") ?? request.headers.get("x-request-id"),
      clientIp: internal ? null : request.headers.get("cf-connecting-ip"),
      country: internal ? null : (cf?.country ?? null),
      region: internal ? null : (cf?.region ?? null),
      regionCode: internal ? null : (cf?.regionCode ?? null),
      city: internal ? null : (cf?.city ?? null),
      asn: internal ? null : (cf?.asn ?? null),
      asOrganization: internal ? null : (cf?.asOrganization ?? null),
      colo: cf?.colo ?? null,
    });
  }
}
