import type { SubmissionRecord } from "../repositories/submission/types";

const POINT_SHARE_SHORT_ORIGIN = "https://oem.re";
const BASE62_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BASE62_BASE = BigInt(BASE62_ALPHABET.length);
const POINT_ID_PERMUTATION_MOD = 1n << 36n;
const POINT_ID_PERMUTATION_MULTIPLIER = 25214903917n;
const POINT_ID_PERMUTATION_OFFSET = 11n;
const POINT_ID_TOKEN_LENGTH = 7;

function encodeBase62(value: bigint): string {
  if (value === 0n) return "0";

  let num = value;
  let encoded = "";
  while (num > 0n) {
    const remainder = Number(num % BASE62_BASE);
    encoded = BASE62_ALPHABET[remainder] + encoded;
    num /= BASE62_BASE;
  }
  return encoded;
}

function encodePointIdToken(pointId: string): string | null {
  if (!/^\d+$/.test(pointId)) return null;

  const id = BigInt(pointId);
  if (id < 0n || id >= POINT_ID_PERMUTATION_MOD) return null;

  const obfuscated = (id * POINT_ID_PERMUTATION_MULTIPLIER + POINT_ID_PERMUTATION_OFFSET) % POINT_ID_PERMUTATION_MOD;
  return encodeBase62(obfuscated).padStart(POINT_ID_TOKEN_LENGTH, "0");
}

export function buildPointShareUrl(submission: SubmissionRecord): string {
  return buildPointShareUrlForMarker(submission.markerId, submission.poiType);
}

export function buildPointShareUrlForMarker(markerId: string, poiType?: string): string {
  const token = encodePointIdToken(markerId);
  if (token) {
    return `${POINT_SHARE_SHORT_ORIGIN}/${encodeURIComponent(token)}`;
  }

  const params = new URLSearchParams();
  params.set("p", markerId);
  if (poiType) params.set("type", poiType);
  return `${POINT_SHARE_SHORT_ORIGIN}/?${params.toString()}`;
}
