export const MIN_KV_EXPIRATION_TTL_SECONDS = 60;
export const DEFAULT_KV_READ_CACHE_TTL_SECONDS = 60;

type KvJsonReadOptions = {
  cacheTtl?: number;
};

const inFlightReadsByNamespace = new WeakMap<KVNamespace, Map<string, Promise<unknown | null>>>();

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function getJsonFromKv<T>(
  kv: KVNamespace | undefined,
  key: string,
  options?: KvJsonReadOptions
): Promise<T | null> {
  if (!kv) return null;

  let inFlightReads = inFlightReadsByNamespace.get(kv);
  if (!inFlightReads) {
    inFlightReads = new Map();
    inFlightReadsByNamespace.set(kv, inFlightReads);
  }

  const cacheTtl = options?.cacheTtl === undefined
    ? undefined
    : Math.max(options.cacheTtl, DEFAULT_KV_READ_CACHE_TTL_SECONDS);
  const inFlightKey = `${cacheTtl ?? "default"}:${key}`;
  const existing = inFlightReads.get(inFlightKey);
  if (existing) {
    return existing as Promise<T | null>;
  }

  const request = (async (): Promise<unknown | null> => {
    const raw = cacheTtl === undefined
      ? await kv.get(key)
      : await kv.get(key, { type: "text", cacheTtl });
    if (!raw) return null;

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  })();
  inFlightReads.set(inFlightKey, request);
  const cleanup = (): void => {
    if (inFlightReads.get(inFlightKey) === request) {
      inFlightReads.delete(inFlightKey);
    }
  };
  void request.then(cleanup, cleanup);
  return request as Promise<T | null>;
}

export async function putJsonToKv(
  kv: KVNamespace | undefined,
  key: string,
  value: unknown,
  options?: { expirationTtl?: number }
): Promise<void> {
  if (!kv) return;
  const putOptions = options?.expirationTtl === undefined
    ? options
    : { ...options, expirationTtl: Math.max(options.expirationTtl, MIN_KV_EXPIRATION_TTL_SECONDS) };
  await kv.put(key, JSON.stringify(value), putOptions);
}
