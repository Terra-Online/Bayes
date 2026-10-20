export const MIN_KV_EXPIRATION_TTL_SECONDS = 60;
export const DEFAULT_KV_READ_CACHE_TTL_SECONDS = 60;

type KvJsonReadOptions = {
  cacheTtl?: number;
};

export async function getJsonFromKv<T>(
  kv: KVNamespace | undefined,
  key: string,
  options?: KvJsonReadOptions,
): Promise<T | null> {
  if (!kv) {
    return null;
  }

  const cacheTtl =
    options?.cacheTtl === undefined
      ? undefined
      : Math.max(options.cacheTtl, DEFAULT_KV_READ_CACHE_TTL_SECONDS);
  let raw: string | null;
  try {
    raw =
      cacheTtl === undefined ? await kv.get(key) : await kv.get(key, { type: "text", cacheTtl });
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function putJsonToKv(
  kv: KVNamespace | undefined,
  key: string,
  value: unknown,
  options?: { expirationTtl?: number },
): Promise<void> {
  if (!kv) {
    return;
  }
  const putOptions =
    options?.expirationTtl === undefined
      ? options
      : {
          ...options,
          expirationTtl: Math.max(options.expirationTtl, MIN_KV_EXPIRATION_TTL_SECONDS),
        };
  await kv.put(key, JSON.stringify(value), putOptions);
}
