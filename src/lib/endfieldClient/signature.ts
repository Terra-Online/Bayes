import { createHash } from "node:crypto";

const textEncoder = new TextEncoder();

export function getEndfieldTimestamp(): string {
  return String(Math.floor((Date.now() - 2_000) / 1000));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return toHex(new Uint8Array(signature));
}

export async function getSignature(path: string, timestamp: string, token: string, body = "", deviceId = ""): Promise<string> {
  const dId = deviceId ? `B${deviceId}` : "";
  const headerJson = JSON.stringify({
    platform: "3",
    timestamp,
    dId,
    vName: "1.0.0"
  });

  const hmacHex = await hmacSha256Hex(path + body + timestamp + headerJson, token);
  return createHash("md5").update(hmacHex).digest("hex");
}

export function createDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function createMessageId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes)
    .map((byte) => alphabet[byte % alphabet.length])
    .join("");
}
