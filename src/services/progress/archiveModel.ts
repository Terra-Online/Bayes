import { ApiError } from "../../lib/errors";

export const ARCHIVE_PROGRESS_BITS_PER_ARCHIVE = 1;
export const ARCHIVE_PROGRESS_FORMAT_VERSION = 1;

export interface ArchiveProgressState {
  version: number;
  revision: string;
  marker: string;
  checksum: string;
  archiveIndexHash: string;
  formatVersion: number;
  bitsPerArchive: number;
  archiveCount: number;
  retainedArchiveIds: string[];
  updatedAt: number | null;
}

export interface PublicArchiveProgressState {
  revision: string;
  archiveIndexHash: string;
  updatedAt: number | null;
  archiveIds: string[];
}

export interface ArchiveProgressSyncPayload {
  baseRevision?: string;
  clientMutationId: string;
  archiveIndexHash: string;
  setArchiveIds?: string[];
  clearArchiveIds?: string[];
  updatedAt: number;
}

export interface ArchiveProgressManifestPayload {
  archiveIndexHash?: string;
  archiveIds?: string[];
}

export function emptyArchiveProgressState(): ArchiveProgressState {
  return {
    version: 0,
    revision: "",
    marker: "",
    checksum: "",
    archiveIndexHash: "",
    formatVersion: ARCHIVE_PROGRESS_FORMAT_VERSION,
    bitsPerArchive: ARCHIVE_PROGRESS_BITS_PER_ARCHIVE,
    archiveCount: 0,
    retainedArchiveIds: [],
    updatedAt: null
  };
}

export function isEmptyArchiveProgress(progress: ArchiveProgressState): boolean {
  return progress.version <= 0 || !progress.marker || progress.archiveCount <= 0;
}

export function publicArchiveProgressState(
  progress: ArchiveProgressState,
  archiveIds: string[] = []
): PublicArchiveProgressState {
  return {
    revision: progress.revision,
    archiveIndexHash: progress.archiveIndexHash,
    updatedAt: progress.updatedAt,
    archiveIds
  };
}

export function requireArchiveTimestampMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ApiError(422, "VALIDATION_ERROR", "updatedAt must be an epoch milliseconds timestamp.");
  }
  return Math.floor(value);
}
