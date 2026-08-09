import type { Bindings } from "../../types/app";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LOCATOR_SOCKET_TICKET_TTL_MS = 2 * 60 * 1_000;
const LOCATOR_SOCKET_TICKET_VERSION = 1;

type LocatorSocketTicketPayload = {
  v: number;
  typ: "locator-socket";
  uid: string;
  exp: number;
  nonce: string;
};

function resolveTicketSecret(env: Bindings): string {
  const secret = env.SERVICE_ID_HMAC_SECRET?.trim() || env.BETTER_AUTH_SECRET?.trim() || "";
  if (secret.length < 16) {
    throw new Error("A locator ticket secret is not configured.");
  }
  return secret;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toCryptoBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function importTicketKey(env: Bindings, usage: KeyUsage): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(resolveTicketSecret(env))
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    [usage]
  );
}

export async function issueLocatorSocketTicket(env: Bindings, uid: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload: LocatorSocketTicketPayload = {
    v: LOCATOR_SOCKET_TICKET_VERSION,
    typ: "locator-socket",
    uid,
    exp: Date.now() + LOCATOR_SOCKET_TICKET_TTL_MS,
    nonce: crypto.randomUUID()
  };
  const key = await importTicketKey(env, "encrypt");
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(payload))
  );
  return `v${LOCATOR_SOCKET_TICKET_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function verifyLocatorSocketTicket(
  env: Bindings,
  ticket: string
): Promise<string | null> {
  try {
    const [version, encodedIv, encodedCiphertext] = ticket.split(".");
    if (
      version !== `v${LOCATOR_SOCKET_TICKET_VERSION}`
      || !encodedIv
      || !encodedCiphertext
      || ticket.length > 4_096
    ) {
      return null;
    }

    const key = await importTicketKey(env, "decrypt");
    const iv = fromBase64Url(encodedIv);
    const ciphertext = fromBase64Url(encodedCiphertext);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toCryptoBuffer(iv) },
      key,
      toCryptoBuffer(ciphertext)
    );
    const payload = JSON.parse(decoder.decode(plaintext)) as Partial<LocatorSocketTicketPayload>;
    if (
      payload.v !== LOCATOR_SOCKET_TICKET_VERSION
      || payload.typ !== "locator-socket"
      || typeof payload.uid !== "string"
      || !payload.uid.trim()
      || typeof payload.exp !== "number"
      || payload.exp <= Date.now()
      || typeof payload.nonce !== "string"
      || !payload.nonce
    ) {
      return null;
    }
    return payload.uid;
  } catch {
    return null;
  }
}
