import { ApiError } from "../lib/errors";
import type { UserRecord } from "../repositories/users";

export const PROGRESS_BITS_PER_POINT = 1;
export const PROGRESS_FORMAT_VERSION = 1;
export const PROGRESS_MARKER_FORMAT = "bitmap-v1";

export interface ProgressState {
  version: number;
  revision: string;
  marker: string;
  checksum: string;
  markerIndexHash: string;
  formatVersion: number;
  bitsPerPoint: number;
  pointCount: number;
  updatedAt: string | null;
  format: string;
}

export interface ProgressSyncPayload {
  baseRevision?: string;
  setPointIds?: string[];
  clearPointIds?: string[];
  clientMutationId?: string;
  updatedAt?: string | number | null;
}

export interface ProgressManifestPayload {
  markerIndexHash?: string;
  pointIds?: string[];
}

export interface ProgressStatsDelta {
  markerIndexHash: string;
  pointCount: number;
  increments: number[];
  decrements: number[];
  firstSync: boolean;
}

export interface ProgressStatsSnapshot {
  markerIndexHash: string;
  pointCount: number;
  totalSyncedUsers: number;
  counts: string;
  updatedAt: string | null;
}

export interface PublicProgressState {
  revision: string;
  markerIndexHash: string;
  updatedAt: string | null;
  pointIds: string[];
}

export function progressStateFromUser(user: UserRecord | null): ProgressState {
  if (!user) {
    return emptyProgressState();
  }

  return {
    version: normalizeNonNegativeInt(user.progressVersion, 0),
    revision: buildProgressRevision(user.progressChecksum || ""),
    marker: user.progressMarker || "",
    checksum: user.progressChecksum || "",
    markerIndexHash: user.progressMarkerIndexHash || "",
    formatVersion: normalizeNonNegativeInt(user.progressFormatVersion, PROGRESS_FORMAT_VERSION),
    bitsPerPoint: normalizeNonNegativeInt(user.progressBitsPerPoint, PROGRESS_BITS_PER_POINT),
    pointCount: normalizeNonNegativeInt(user.progressPointCount, 0),
    updatedAt: user.progressUpdatedAt || null,
    format: PROGRESS_MARKER_FORMAT
  };
}

export function emptyProgressState(): ProgressState {
  return {
    version: 0,
    revision: "",
    marker: "",
    checksum: "",
    markerIndexHash: "",
    formatVersion: PROGRESS_FORMAT_VERSION,
    bitsPerPoint: PROGRESS_BITS_PER_POINT,
    pointCount: 0,
    updatedAt: null,
    format: PROGRESS_MARKER_FORMAT
  };
}

export function isEmptyProgress(progress: ProgressState): boolean {
  return progress.version <= 0 || !progress.marker || progress.pointCount <= 0;
}

export function buildProgressRevision(checksum: string): string {
  return checksum || "";
}

export function publicProgressState(progress: ProgressState, pointIds: string[] = []): PublicProgressState {
  return {
    revision: progress.revision,
    markerIndexHash: progress.markerIndexHash,
    updatedAt: progress.updatedAt,
    pointIds
  };
}

export function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return fallback;
  }
  return Math.floor(normalized);
}

export function normalizeOptionalTimestamp(value: string | number | null | undefined): string {
  if (value === undefined || value === null || value === "") {
    return new Date().toISOString();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }

  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return new Date().toISOString();
    if (/^\d+$/.test(raw)) {
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) {
        const ms = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
        return new Date(ms).toISOString();
      }
    }
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return new Date().toISOString();
}

export function decodeBase64(value: string): Uint8Array {
  if (!value) return new Uint8Array(0);
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new ApiError(422, "INVALID_PROGRESS_MARKER", "Progress marker must be base64 encoded bitmap data.");
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary);
}

export function expectedBitmapBytes(pointCount: number, bitsPerPoint: number): number {
  return Math.ceil((pointCount * bitsPerPoint) / 8);
}

export function normalizeBitmapBytes(marker: string, pointCount: number, bitsPerPoint: number): Uint8Array {
  const expected = expectedBitmapBytes(pointCount, bitsPerPoint);
  const decoded = decodeBase64(marker);

  if (decoded.length === expected) {
    return decoded;
  }

  if (decoded.length < expected) {
    const padded = new Uint8Array(expected);
    padded.set(decoded);
    return padded;
  }

  return decoded.slice(0, expected);
}

export function emptyBitmapBytes(pointCount: number, bitsPerPoint = PROGRESS_BITS_PER_POINT): Uint8Array {
  return new Uint8Array(expectedBitmapBytes(pointCount, bitsPerPoint));
}

export function getBitmapBit(bytes: Uint8Array, index: number): boolean {
  const byteIndex = Math.floor(index / 8);
  const bitIndex = index % 8;
  return ((bytes[byteIndex] ?? 0) & (1 << bitIndex)) !== 0;
}

export function setBitmapBit(bytes: Uint8Array, index: number, value: boolean): void {
  const byteIndex = Math.floor(index / 8);
  const bitIndex = index % 8;
  if (value) {
    bytes[byteIndex] = (bytes[byteIndex] ?? 0) | (1 << bitIndex);
  } else {
    bytes[byteIndex] = (bytes[byteIndex] ?? 0) & ~(1 << bitIndex);
  }
}

export function diffOneBitBitmaps(
  before: Uint8Array,
  after: Uint8Array,
  pointCount: number
): { increments: number[]; decrements: number[] } {
  const increments: number[] = [];
  const decrements: number[] = [];

  for (let byteIndex = 0; byteIndex < Math.ceil(pointCount / 8); byteIndex += 1) {
    const oldByte = before[byteIndex] ?? 0;
    const newByte = after[byteIndex] ?? 0;
    const changed = oldByte ^ newByte;
    if (changed === 0) continue;

    for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
      const pointIndex = byteIndex * 8 + bitIndex;
      if (pointIndex >= pointCount) break;
      if ((changed & (1 << bitIndex)) === 0) continue;

      if ((newByte & (1 << bitIndex)) !== 0) {
        increments.push(pointIndex);
      } else {
        decrements.push(pointIndex);
      }
    }
  }

  return { increments, decrements };
}

export async function checksumProgressBitmap(
  bytes: Uint8Array,
  metadata: {
    markerIndexHash: string;
    formatVersion: number;
    bitsPerPoint: number;
    pointCount: number;
  }
): Promise<string> {
  const encoder = new TextEncoder();
  const prefix = encoder.encode([
    PROGRESS_MARKER_FORMAT,
    metadata.formatVersion,
    metadata.markerIndexHash,
    metadata.bitsPerPoint,
    metadata.pointCount
  ].join(":"));
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix, 0);
  input.set(bytes, prefix.length);
  const digest = await crypto.subtle.digest("SHA-256", input as unknown as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function buildStatsCountsBase64(counts: Uint32Array): string {
  return encodeBase64(new Uint8Array(counts.buffer.slice(0)));
}

export function parseStatsCountsBase64(value: string, pointCount: number): Uint32Array {
  const bytes = decodeBase64(value);
  const expectedBytes = pointCount * Uint32Array.BYTES_PER_ELEMENT;
  const normalized = bytes.length === expectedBytes ? bytes : normalizeStatsBytes(bytes, expectedBytes);
  const buffer = normalized.buffer.slice(
    normalized.byteOffset,
    normalized.byteOffset + normalized.byteLength
  );
  return new Uint32Array(buffer);
}

function normalizeStatsBytes(bytes: Uint8Array, expectedBytes: number): Uint8Array {
  if (bytes.length > expectedBytes) {
    return bytes.slice(0, expectedBytes);
  }
  const padded = new Uint8Array(expectedBytes);
  padded.set(bytes);
  return padded;
}
