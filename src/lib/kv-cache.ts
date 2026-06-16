export const MIN_KV_EXPIRATION_TTL_SECONDS = 60;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function getJsonFromKv<T>(kv: KVNamespace | undefined, key: string): Promise<T | null> {
  if (!kv) return null;
  const raw = await kv.get(key);
  if (!raw) return null;

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
  options?: { expirationTtl?: number }
): Promise<void> {
  if (!kv) return;
  const putOptions = options?.expirationTtl === undefined
    ? options
    : { ...options, expirationTtl: Math.max(options.expirationTtl, MIN_KV_EXPIRATION_TTL_SECONDS) };
  await kv.put(key, JSON.stringify(value), putOptions);
}
