import { ApiError } from "../../lib/errors";
import type { UserRecord } from "../../repositories/users";

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
  updatedAt: number | null;
  format: string;
}

export interface ProgressSyncPayload {
  baseRevision?: string;
  setPointIds?: string[];
  clearPointIds?: string[];
  clientMutationId?: string;
  updatedAt: number;
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
  updatedAt: number | null;
}

export interface PublicProgressState {
  revision: string;
  markerIndexHash: string;
  updatedAt: number | null;
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

export function requireTimestampMs(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ApiError(422, "VALIDATION_ERROR", `${fieldName} must be an epoch milliseconds timestamp.`);
  }
  return Math.floor(value);
}

export function nowTimestampMs(): number {
  return Date.now();
}
