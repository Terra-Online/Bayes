import { ApiError } from "../../lib/errors";
import { getJsonFromKv, putJsonToKv, sha256Hex } from "../../middleware/cache/kvJson";
import type { Bindings } from "../../types/app";
import {
  PROGRESS_BITS_PER_POINT,
  PROGRESS_FORMAT_VERSION,
  normalizeNonNegativeInt,
  nowTimestampMs,
  type ProgressManifestPayload
} from "./model";
import { getBitmapBit } from "./bitmap";

export type ProgressDoEnv = Bindings;

export type RegisteredManifest = {
  markerIndexHash: string;
  formatVersion: number;
  bitsPerPoint: number;
  pointIds: string[];
  pointCount: number;
  indexById: Map<string, number>;
};

type StoredManifest = Omit<RegisteredManifest, "indexById">;

const ACTIVE_MANIFEST_HASH_KEY = "progress:active-manifest-hash:v1";
const MANIFEST_KV_KEY_PREFIX = "progress:manifest:v1:";

export function normalizePointIds(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new ApiError(422, "VALIDATION_ERROR", `${fieldName} must be an array.`);
  }

  const pointIds = value
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);

  if (pointIds.length !== new Set(pointIds).size) {
    return [...new Set(pointIds)];
  }
  return pointIds;
}

export function buildCanonicalMarkerManifest(pointIds: string[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    mapId: "endfield",
    points: pointIds
  });
}

export function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export async function normalizeManifestPayload(raw: unknown): Promise<RegisteredManifest> {
  if (!raw || typeof raw !== "object") {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid progress manifest payload.");
  }

  const payload = raw as ProgressManifestPayload;
  const markerIndexHash = typeof payload.markerIndexHash === "string"
    ? payload.markerIndexHash.trim().toLowerCase()
    : "";
  const pointIds = normalizePointIds(payload.pointIds, "pointIds");

  if (!isSha256Hex(markerIndexHash) || pointIds.length === 0) {
    throw new ApiError(422, "VALIDATION_ERROR", "Progress manifest metadata is incomplete.");
  }

  const computedHash = await sha256Hex(buildCanonicalMarkerManifest(pointIds));
  if (computedHash !== markerIndexHash) {
    throw new ApiError(422, "PROGRESS_MANIFEST_HASH_MISMATCH", "Progress manifest hash does not match point index.");
  }

  return {
    markerIndexHash,
    formatVersion: PROGRESS_FORMAT_VERSION,
    bitsPerPoint: PROGRESS_BITS_PER_POINT,
    pointIds,
    pointCount: pointIds.length,
    indexById: new Map(pointIds.map((id, index) => [id, index]))
  };
}

export function pointIdsFromBitmap(bytes: Uint8Array, manifest: RegisteredManifest): string[] {
  const pointIds: string[] = [];
  for (let index = 0; index < manifest.pointCount; index += 1) {
    if (getBitmapBit(bytes, index)) {
      const pointId = manifest.pointIds[index];
      if (pointId) pointIds.push(pointId);
    }
  }
  return pointIds;
}

function manifestFromStored(stored: StoredManifest): RegisteredManifest {
  return {
    ...stored,
    indexById: new Map(stored.pointIds.map((id, index) => [id, index]))
  };
}

function manifestToStored(manifest: RegisteredManifest): StoredManifest {
  return {
    markerIndexHash: manifest.markerIndexHash,
    formatVersion: manifest.formatVersion,
    bitsPerPoint: manifest.bitsPerPoint,
    pointIds: manifest.pointIds,
    pointCount: manifest.pointCount
  };
}

export async function loadProgressManifest(
  env: ProgressDoEnv,
  markerIndexHash: string
): Promise<RegisteredManifest | null> {
  const cached = await getJsonFromKv<StoredManifest>(
    env.OEM_KV,
    `${MANIFEST_KV_KEY_PREFIX}${markerIndexHash}`
  );
  if (cached) {
    return manifestFromStored(cached);
  }

  const row = await env.DB
    .prepare(
      `SELECT marker_index_hash, format_version, bits_per_point, point_count, point_ids
       FROM progress_marker_manifests
       WHERE marker_index_hash = ?1
       LIMIT 1`
    )
    .bind(markerIndexHash)
    .first<{
      marker_index_hash: string;
      format_version: number;
      bits_per_point: number;
      point_count: number;
      point_ids: string;
    }>();
  if (!row) return null;

  const pointIds = JSON.parse(row.point_ids) as string[];
  const manifest = {
    markerIndexHash: row.marker_index_hash,
    formatVersion: normalizeNonNegativeInt(row.format_version, PROGRESS_FORMAT_VERSION),
    bitsPerPoint: normalizeNonNegativeInt(row.bits_per_point, PROGRESS_BITS_PER_POINT),
    pointCount: normalizeNonNegativeInt(row.point_count, pointIds.length),
    pointIds,
    indexById: new Map(pointIds.map((id, index) => [id, index]))
  };
  await putJsonToKv(
    env.OEM_KV,
    `${MANIFEST_KV_KEY_PREFIX}${manifest.markerIndexHash}`,
    manifestToStored(manifest)
  ).catch(() => undefined);
  return manifest;
}

export async function saveProgressManifest(
  env: ProgressDoEnv,
  state: DurableObjectState,
  manifest: RegisteredManifest
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO progress_marker_manifests
         (marker_index_hash, format_version, bits_per_point, point_count, point_ids, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(marker_index_hash) DO NOTHING`
    )
    .bind(
      manifest.markerIndexHash,
      manifest.formatVersion,
      manifest.bitsPerPoint,
      manifest.pointCount,
      JSON.stringify(manifest.pointIds),
      nowTimestampMs()
    )
    .run();
  await state.storage.put(ACTIVE_MANIFEST_HASH_KEY, manifest.markerIndexHash);
  await putJsonToKv(
    env.OEM_KV,
    `${MANIFEST_KV_KEY_PREFIX}${manifest.markerIndexHash}`,
    manifestToStored(manifest)
  ).catch(() => undefined);
}

export async function loadActiveProgressManifest(
  env: ProgressDoEnv,
  state: DurableObjectState
): Promise<RegisteredManifest> {
  const markerIndexHash = await state.storage.get<string>(ACTIVE_MANIFEST_HASH_KEY);
  if (!markerIndexHash) {
    throw new ApiError(409, "PROGRESS_MANIFEST_NOT_REGISTERED", "Progress manifest must be registered before sync.");
  }

  const manifest = await loadProgressManifest(env, markerIndexHash);
  if (!manifest) {
    throw new ApiError(409, "PROGRESS_MANIFEST_NOT_REGISTERED", "Progress manifest must be registered before sync.");
  }

  return manifest;
}

export async function getActiveProgressManifestHash(state: DurableObjectState): Promise<string | undefined> {
  return state.storage.get<string>(ACTIVE_MANIFEST_HASH_KEY);
}
