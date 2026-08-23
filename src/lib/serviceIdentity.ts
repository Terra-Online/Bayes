import type { Bindings } from "../types/app";

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function resolveServiceHmacSecret(env: Bindings): string {
  const secret = (
    env.SERVICE_ID_HMAC_SECRET
    ?? env.BETTER_AUTH_SECRET
    ?? env.ENDFIELD_CREDENTIAL_SECRET
    ?? ""
  ).trim();

  return secret.length >= 16 ? secret : "oem-backend-local-service-id-secret";
}

export async function hmacServiceIdentifier(
  env: Bindings,
  namespace: string,
  value: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(resolveServiceHmacSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${namespace}:${value}`)
  );
  return toBase64Url(new Uint8Array(signature));
}

export async function durableObjectNameForSecret(
  env: Bindings,
  namespace: string,
  value: string
): Promise<string> {
  return `v1:${namespace}:${await hmacServiceIdentifier(env, namespace, value)}`;
}
