import { getJsonFromKv, MIN_KV_EXPIRATION_TTL_SECONDS, putJsonToKv } from "../../middleware/cache/kvJson";
import { CACHE_KEY_VERSIONS } from "../../middleware/cache/versions";
import type { Bindings } from "../../types/app";

export const PROGRESS_STATS_HTTP_MAX_AGE_SECONDS = 10;
export const PROGRESS_STATS_KV_TTL_SECONDS = MIN_KV_EXPIRATION_TTL_SECONDS;

const PROGRESS_STATS_KV_KEY_PREFIX = `progress:stats:${CACHE_KEY_VERSIONS.progressStats}:`;

function jsonResponse(payload: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

export async function buildPublicProgressStatsResponse(
  env: Bindings,
  markerIndexHash: string
): Promise<Response> {
  const kvKey = `${PROGRESS_STATS_KV_KEY_PREFIX}${markerIndexHash}`;
  const cached = await getJsonFromKv<unknown>(env.OEM_KV, kvKey);
  if (cached) {
    return jsonResponse(cached, {
      "Cache-Control": `public, max-age=${PROGRESS_STATS_HTTP_MAX_AGE_SECONDS}`,
      "Cloudflare-CDN-Cache-Control": `public, max-age=${PROGRESS_STATS_KV_TTL_SECONDS}`,
      "x-oem-kv-cache": "hit"
    });
  }

  const id = env.OEM_STATS_DO.idFromName(markerIndexHash);
  const stub = env.OEM_STATS_DO.get(id);
  const url = new URL("https://progress-stats/state");
  url.searchParams.set("markerIndexHash", markerIndexHash);
  const response = await stub.fetch(new Request(url, { method: "GET" }));
  if (!response.ok) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  const payload = await response.clone().json().catch(() => null);
  if (payload) {
    await putJsonToKv(env.OEM_KV, kvKey, payload, {
      expirationTtl: PROGRESS_STATS_KV_TTL_SECONDS
    }).catch(() => undefined);
  }

  return jsonResponse(payload, {
    "Cache-Control": `public, max-age=${PROGRESS_STATS_HTTP_MAX_AGE_SECONDS}`,
    "Cloudflare-CDN-Cache-Control": `public, max-age=${PROGRESS_STATS_KV_TTL_SECONDS}`,
    "x-oem-kv-cache": "miss"
  });
}
