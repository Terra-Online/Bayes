const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return fromBase64(padded);
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const iterations = 120000;

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );

  return `${iterations}.${toBase64(salt)}.${toBase64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [iterationsRaw, saltRaw, hashRaw] = storedHash.split(".");
  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!iterationsRaw || !saltRaw || !hashRaw || !Number.isFinite(iterations) || iterations <= 0) {
    return false;
  }

  const salt = fromBase64(saltRaw);
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );

  const computed = toBase64(new Uint8Array(bits));
  return computed === hashRaw;
}

export function createToken(size = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return toBase64Url(bytes);
}

async function importAesKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(secret);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    encoder.encode(value)
  );

  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(value: string, secret: string): Promise<string> {
  const [version, ivRaw, encryptedRaw] = value.split(".");
  if (version !== "v1" || !ivRaw || !encryptedRaw) {
    throw new Error("INVALID_ENCRYPTED_SECRET");
  }

  const key = await importAesKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(ivRaw) as unknown as BufferSource },
    key,
    fromBase64Url(encryptedRaw) as unknown as BufferSource
  );

  return decoder.decode(decrypted);
}
