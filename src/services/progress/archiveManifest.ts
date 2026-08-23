import { ApiError } from "../../lib/errors";
import { getJsonFromKv, putJsonToKv, sha256Hex } from "../../middleware/cache/kvJson";
import { CACHE_KEY_VERSIONS } from "../../middleware/cache/versions";
import type { Bindings } from "../../types/app";
import { getBitmapBit } from "./bitmap";
import { isSha256Hex } from "./manifest";
import {
  ARCHIVE_PROGRESS_BITS_PER_ARCHIVE,
  ARCHIVE_PROGRESS_FORMAT_VERSION,
  type ArchiveProgressManifestPayload
} from "./archiveModel";

export type RegisteredArchiveManifest = {
  archiveIndexHash: string;
  formatVersion: number;
  bitsPerArchive: number;
  archiveIds: string[];
  archiveCount: number;
  indexById: Map<string, number>;
};

type StoredArchiveManifest = Omit<RegisteredArchiveManifest, "indexById">;

const MANIFEST_KV_KEY_PREFIX = `progress:archive-manifest:${CACHE_KEY_VERSIONS.archiveProgressManifest}:`;
const MAX_ARCHIVE_COUNT = 20_000;
const MAX_ARCHIVE_ID_LENGTH = 256;

export function normalizeArchiveIds(
  value: unknown,
  fieldName: string,
  options: { requireSorted?: boolean } = {}
): string[] {
  if (!Array.isArray(value)) {
    throw new ApiError(422, "VALIDATION_ERROR", `${fieldName} must be an array.`);
  }
  if (value.length > MAX_ARCHIVE_COUNT) {
    throw new ApiError(422, "VALIDATION_ERROR", `${fieldName} contains too many archive ids.`);
  }

  const archiveIds = value.map((item) => {
    if (typeof item !== "string") {
      throw new ApiError(422, "VALIDATION_ERROR", `${fieldName} must contain only strings.`);
    }
    const archiveId = item.trim();
    if (!archiveId || archiveId.length > MAX_ARCHIVE_ID_LENGTH) {
      throw new ApiError(422, "VALIDATION_ERROR", `${fieldName} contains an invalid archive id.`);
    }
    return archiveId;
  });
  const uniqueIds = [...new Set(archiveIds)];

  if (options.requireSorted) {
    if (uniqueIds.length !== archiveIds.length) {
      throw new ApiError(422, "VALIDATION_ERROR", `${fieldName} must not contain duplicate archive ids.`);
    }
    const sortedIds = [...archiveIds].sort();
    if (sortedIds.some((archiveId, index) => archiveId !== archiveIds[index])) {
      throw new ApiError(422, "VALIDATION_ERROR", `${fieldName} must be sorted.`);
    }
  }

  return uniqueIds;
}

export function buildCanonicalArchiveManifest(archiveIds: string[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    scope: "intel-archives",
    archives: archiveIds
  });
}

export async function normalizeArchiveManifestPayload(raw: unknown): Promise<RegisteredArchiveManifest> {
  if (!raw || typeof raw !== "object") {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid archive progress manifest payload.");
  }

  const payload = raw as ArchiveProgressManifestPayload;
  const archiveIndexHash = typeof payload.archiveIndexHash === "string"
    ? payload.archiveIndexHash.trim().toLowerCase()
    : "";
  const archiveIds = normalizeArchiveIds(payload.archiveIds, "archiveIds", { requireSorted: true });
  if (!isSha256Hex(archiveIndexHash) || archiveIds.length === 0) {
    throw new ApiError(422, "VALIDATION_ERROR", "Archive progress manifest metadata is incomplete.");
  }

  const computedHash = await sha256Hex(buildCanonicalArchiveManifest(archiveIds));
  if (computedHash !== archiveIndexHash) {
    throw new ApiError(
      422,
      "ARCHIVE_PROGRESS_MANIFEST_HASH_MISMATCH",
      "Archive progress manifest hash does not match archive index."
    );
  }

  return {
    archiveIndexHash,
    formatVersion: ARCHIVE_PROGRESS_FORMAT_VERSION,
    bitsPerArchive: ARCHIVE_PROGRESS_BITS_PER_ARCHIVE,
    archiveIds,
    archiveCount: archiveIds.length,
    indexById: new Map(archiveIds.map((archiveId, index) => [archiveId, index]))
  };
}

export function archiveIdsFromBitmap(bytes: Uint8Array, manifest: RegisteredArchiveManifest): string[] {
  const archiveIds: string[] = [];
  for (let index = 0; index < manifest.archiveCount; index += 1) {
    if (!getBitmapBit(bytes, index)) continue;
    const archiveId = manifest.archiveIds[index];
    if (archiveId) archiveIds.push(archiveId);
  }
  return archiveIds;
}

function manifestFromStored(stored: StoredArchiveManifest): RegisteredArchiveManifest {
  return {
    ...stored,
    indexById: new Map(stored.archiveIds.map((archiveId, index) => [archiveId, index]))
  };
}

function manifestToStored(manifest: RegisteredArchiveManifest): StoredArchiveManifest {
  return {
    archiveIndexHash: manifest.archiveIndexHash,
    formatVersion: manifest.formatVersion,
    bitsPerArchive: manifest.bitsPerArchive,
    archiveIds: manifest.archiveIds,
    archiveCount: manifest.archiveCount
  };
}

export async function loadArchiveProgressManifest(
  env: Bindings,
  archiveIndexHash: string
): Promise<RegisteredArchiveManifest | null> {
  const cacheKey = `${MANIFEST_KV_KEY_PREFIX}${archiveIndexHash}`;
  const cached = await getJsonFromKv<StoredArchiveManifest>(env.OEM_KV, cacheKey);
  if (cached) return manifestFromStored(cached);

  const row = await env.DB.prepare(
    `SELECT archive_index_hash, format_version, bits_per_archive, archive_count, archive_ids
     FROM archive_progress_manifests
     WHERE archive_index_hash = ?1
     LIMIT 1`
  ).bind(archiveIndexHash).first<{
    archive_index_hash: string;
    format_version: number;
    bits_per_archive: number;
    archive_count: number;
    archive_ids: string;
  }>();
  if (!row) return null;

  const archiveIds = JSON.parse(row.archive_ids) as string[];
  const manifest: RegisteredArchiveManifest = {
    archiveIndexHash: row.archive_index_hash,
    formatVersion: Number(row.format_version),
    bitsPerArchive: Number(row.bits_per_archive),
    archiveCount: Number(row.archive_count),
    archiveIds,
    indexById: new Map(archiveIds.map((archiveId, index) => [archiveId, index]))
  };
  await putJsonToKv(env.OEM_KV, cacheKey, manifestToStored(manifest)).catch(() => undefined);
  return manifest;
}

export async function saveArchiveProgressManifest(
  env: Bindings,
  manifest: RegisteredArchiveManifest
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO archive_progress_manifests
       (archive_index_hash, format_version, bits_per_archive, archive_count, archive_ids, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(archive_index_hash) DO NOTHING`
  ).bind(
    manifest.archiveIndexHash,
    manifest.formatVersion,
    manifest.bitsPerArchive,
    manifest.archiveCount,
    JSON.stringify(manifest.archiveIds),
    Date.now()
  ).run();
  await putJsonToKv(
    env.OEM_KV,
    `${MANIFEST_KV_KEY_PREFIX}${manifest.archiveIndexHash}`,
    manifestToStored(manifest)
  ).catch(() => undefined);
}
