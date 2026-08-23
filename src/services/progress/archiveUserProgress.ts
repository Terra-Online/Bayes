import { ApiError } from "../../lib/errors";
import { sha256Hex } from "../../middleware/cache/kvJson";
import { getUserByUid } from "../../repositories/users";
import type { Bindings } from "../../types/app";
import {
  checksumProgressBitmap,
  emptyBitmapBytes,
  encodeBase64,
  normalizeBitmapBytes,
  setBitmapBit
} from "./bitmap";
import {
  archiveIdsFromBitmap,
  loadArchiveProgressManifest,
  normalizeArchiveIds,
  type RegisteredArchiveManifest
} from "./archiveManifest";
import {
  ARCHIVE_PROGRESS_BITS_PER_ARCHIVE,
  ARCHIVE_PROGRESS_FORMAT_VERSION,
  emptyArchiveProgressState,
  isEmptyArchiveProgress,
  publicArchiveProgressState,
  requireArchiveTimestampMs,
  type ArchiveProgressState,
  type ArchiveProgressSyncPayload,
  type PublicArchiveProgressState
} from "./archiveModel";
import {
  commitArchiveProgressSync,
  getArchiveProgressSyncMutation,
  getUserArchiveProgress
} from "./archiveRepository";
import { isSha256Hex } from "./manifest";
import { jsonResponse } from "./responses";

export type NormalizedArchiveSyncPatch = {
  baseRevision: string;
  clientMutationId: string;
  archiveIndexHash: string;
  setArchiveIds: string[];
  clearArchiveIds: string[];
  updatedAt: number;
};

export type PreparedArchiveProgress = {
  progress: ArchiveProgressState;
  bytes: Uint8Array;
  retainedArchiveIds: string[];
  migrated: boolean;
};

function normalizeRetainedArchiveIds(archiveIds: string[]): string[] {
  return [...new Set(archiveIds.map((archiveId) => archiveId.trim()).filter(Boolean))].sort();
}

function areStringSetsEqual(first: string[], second: string[]): boolean {
  if (first.length !== second.length) return false;
  const firstSet = new Set(first);
  return second.every((item) => firstSet.has(item));
}

function bitmapEquals(first: Uint8Array, second: Uint8Array): boolean {
  return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

export function normalizeArchiveSyncPatch(raw: unknown): NormalizedArchiveSyncPatch {
  if (!raw || typeof raw !== "object") {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid archive progress sync payload.");
  }

  const payload = raw as ArchiveProgressSyncPayload;
  const baseRevision = typeof payload.baseRevision === "string" ? payload.baseRevision.trim().toLowerCase() : "";
  const clientMutationId = typeof payload.clientMutationId === "string" ? payload.clientMutationId.trim() : "";
  const archiveIndexHash = typeof payload.archiveIndexHash === "string"
    ? payload.archiveIndexHash.trim().toLowerCase()
    : "";
  if (baseRevision && !isSha256Hex(baseRevision)) {
    throw new ApiError(422, "VALIDATION_ERROR", "baseRevision must be an opaque archive progress revision.");
  }
  if (!clientMutationId || clientMutationId.length > 128) {
    throw new ApiError(422, "VALIDATION_ERROR", "clientMutationId must contain between 1 and 128 characters.");
  }
  if (!isSha256Hex(archiveIndexHash)) {
    throw new ApiError(422, "VALIDATION_ERROR", "archiveIndexHash must be a SHA-256 hash.");
  }

  return {
    baseRevision,
    clientMutationId,
    archiveIndexHash,
    setArchiveIds: normalizeArchiveIds(payload.setArchiveIds ?? [], "setArchiveIds"),
    clearArchiveIds: normalizeArchiveIds(payload.clearArchiveIds ?? [], "clearArchiveIds"),
    updatedAt: requireArchiveTimestampMs(payload.updatedAt)
  };
}

export async function buildArchiveSyncRequestHash(incoming: NormalizedArchiveSyncPatch): Promise<string> {
  return sha256Hex(JSON.stringify({
    baseRevision: incoming.baseRevision,
    archiveIndexHash: incoming.archiveIndexHash,
    setArchiveIds: [...incoming.setArchiveIds].sort(),
    clearArchiveIds: [...incoming.clearArchiveIds].sort(),
    updatedAt: incoming.updatedAt
  }));
}

export async function prepareArchiveProgressForManifest(
  progress: ArchiveProgressState,
  targetManifest: RegisteredArchiveManifest,
  sourceManifest?: RegisteredArchiveManifest
): Promise<PreparedArchiveProgress> {
  const retained = new Set(normalizeRetainedArchiveIds(progress.retainedArchiveIds));
  const nextBytes = emptyBitmapBytes(targetManifest.archiveCount, targetManifest.bitsPerArchive);
  const progressIsEmpty = isEmptyArchiveProgress(progress);
  const sameManifest = !progressIsEmpty
    && progress.archiveIndexHash === targetManifest.archiveIndexHash
    && progress.formatVersion === targetManifest.formatVersion
    && progress.bitsPerArchive === targetManifest.bitsPerArchive
    && progress.archiveCount === targetManifest.archiveCount;

  let sourceBytes: Uint8Array | null = null;
  if (!progressIsEmpty) {
    const activeSourceManifest = sameManifest ? targetManifest : sourceManifest;
    if (!activeSourceManifest) {
      throw new ApiError(
        409,
        "ARCHIVE_PROGRESS_MANIFEST_NOT_REGISTERED",
        "Current archive progress manifest is not registered."
      );
    }
    sourceBytes = normalizeBitmapBytes(
      progress.marker,
      activeSourceManifest.archiveCount,
      activeSourceManifest.bitsPerArchive
    );
    for (const archiveId of archiveIdsFromBitmap(sourceBytes, activeSourceManifest)) {
      const targetIndex = targetManifest.indexById.get(archiveId);
      if (targetIndex === undefined) retained.add(archiveId);
      else setBitmapBit(nextBytes, targetIndex, true);
    }
  }

  for (const archiveId of [...retained]) {
    const targetIndex = targetManifest.indexById.get(archiveId);
    if (targetIndex === undefined) continue;
    setBitmapBit(nextBytes, targetIndex, true);
    retained.delete(archiveId);
  }

  const nextRetainedArchiveIds = normalizeRetainedArchiveIds([...retained]);
  const bitmapChanged = sameManifest && sourceBytes ? !bitmapEquals(sourceBytes, nextBytes) : false;
  const retainedChanged = !areStringSetsEqual(
    normalizeRetainedArchiveIds(progress.retainedArchiveIds),
    nextRetainedArchiveIds
  );
  const migrated = (!progressIsEmpty && !sameManifest) || bitmapChanged || retainedChanged;
  if (!migrated) {
    return {
      progress,
      bytes: progressIsEmpty ? nextBytes : (sourceBytes as Uint8Array),
      retainedArchiveIds: nextRetainedArchiveIds,
      migrated: false
    };
  }

  const checksum = await checksumProgressBitmap(nextBytes, {
    markerIndexHash: targetManifest.archiveIndexHash,
    formatVersion: targetManifest.formatVersion,
    bitsPerPoint: targetManifest.bitsPerArchive,
    pointCount: targetManifest.archiveCount
  });
  return {
    progress: {
      ...progress,
      revision: checksum,
      marker: encodeBase64(nextBytes),
      checksum,
      archiveIndexHash: targetManifest.archiveIndexHash,
      formatVersion: targetManifest.formatVersion,
      bitsPerArchive: targetManifest.bitsPerArchive,
      archiveCount: targetManifest.archiveCount,
      retainedArchiveIds: nextRetainedArchiveIds
    },
    bytes: nextBytes,
    retainedArchiveIds: nextRetainedArchiveIds,
    migrated: true
  };
}

export function applyArchiveProgressPatch(
  bytes: Uint8Array,
  retainedArchiveIds: string[],
  manifest: RegisteredArchiveManifest,
  patch: Pick<NormalizedArchiveSyncPatch, "setArchiveIds" | "clearArchiveIds">
): { bytes: Uint8Array; retainedArchiveIds: string[] } {
  const nextBytes = new Uint8Array(bytes);
  const retained = new Set(retainedArchiveIds);
  for (const archiveId of patch.clearArchiveIds) {
    const index = manifest.indexById.get(archiveId);
    if (index !== undefined) setBitmapBit(nextBytes, index, false);
    retained.delete(archiveId);
  }
  for (const archiveId of patch.setArchiveIds) {
    const index = manifest.indexById.get(archiveId);
    if (index === undefined) retained.add(archiveId);
    else {
      setBitmapBit(nextBytes, index, true);
      retained.delete(archiveId);
    }
  }
  return {
    bytes: nextBytes,
    retainedArchiveIds: normalizeRetainedArchiveIds([...retained])
  };
}

function emptyPublicArchiveProgress(archiveIndexHash: string): PublicArchiveProgressState {
  return {
    ...publicArchiveProgressState(emptyArchiveProgressState()),
    archiveIndexHash
  };
}

function publicPreparedProgress(
  prepared: PreparedArchiveProgress,
  manifest: RegisteredArchiveManifest
): PublicArchiveProgressState {
  if (isEmptyArchiveProgress(prepared.progress)) {
    return emptyPublicArchiveProgress(manifest.archiveIndexHash);
  }
  return publicArchiveProgressState(
    prepared.progress,
    archiveIdsFromBitmap(prepared.bytes, manifest)
  );
}

async function requireSourceManifest(
  env: Bindings,
  progress: ArchiveProgressState,
  targetManifest: RegisteredArchiveManifest
): Promise<RegisteredArchiveManifest | undefined> {
  if (isEmptyArchiveProgress(progress) || progress.archiveIndexHash === targetManifest.archiveIndexHash) {
    return undefined;
  }
  const sourceManifest = await loadArchiveProgressManifest(env, progress.archiveIndexHash);
  if (!sourceManifest) {
    throw new ApiError(
      409,
      "ARCHIVE_PROGRESS_MANIFEST_NOT_REGISTERED",
      "Current archive progress manifest is not registered."
    );
  }
  return sourceManifest;
}

export async function handleArchiveProgressState(
  env: Bindings,
  uid: string,
  manifest: RegisteredArchiveManifest
): Promise<Response> {
  const progress = await getUserArchiveProgress(env.DB, uid);
  const sourceManifest = await requireSourceManifest(env, progress, manifest);
  const prepared = await prepareArchiveProgressForManifest(progress, manifest, sourceManifest);
  return jsonResponse({ progress: publicPreparedProgress(prepared, manifest) });
}

export async function handleArchiveProgressSync(
  env: Bindings,
  uid: string,
  incoming: NormalizedArchiveSyncPatch,
  requestHash: string,
  manifest: RegisteredArchiveManifest
): Promise<Response> {
  const existingMutation = await getArchiveProgressSyncMutation(env.DB, uid, incoming.clientMutationId);
  if (existingMutation) {
    if (existingMutation.requestHash !== requestHash) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "clientMutationId was already used for a different archive progress payload."
      );
    }
    return new Response(existingMutation.responseJson, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-progress-idempotent": "true"
      }
    });
  }

  if (!await getUserByUid(env.DB, uid)) {
    throw new ApiError(404, "USER_NOT_FOUND", "User profile was not found.");
  }

  const current = await getUserArchiveProgress(env.DB, uid);
  const sourceManifest = await requireSourceManifest(env, current, manifest);
  const prepared = await prepareArchiveProgressForManifest(current, manifest, sourceManifest);
  if (incoming.baseRevision !== current.revision && incoming.baseRevision !== prepared.progress.revision) {
    throw new ApiError(
      409,
      "ARCHIVE_PROGRESS_REVISION_CONFLICT",
      "Incoming patch is based on an older archive progress revision.",
      { current: publicPreparedProgress(prepared, manifest) }
    );
  }

  const patched = applyArchiveProgressPatch(
    prepared.bytes,
    prepared.retainedArchiveIds,
    manifest,
    incoming
  );
  const checksum = await checksumProgressBitmap(patched.bytes, {
    markerIndexHash: manifest.archiveIndexHash,
    formatVersion: ARCHIVE_PROGRESS_FORMAT_VERSION,
    bitsPerPoint: ARCHIVE_PROGRESS_BITS_PER_ARCHIVE,
    pointCount: manifest.archiveCount
  });
  const retainedChanged = !areStringSetsEqual(prepared.retainedArchiveIds, patched.retainedArchiveIds);
  const progressChanged = prepared.migrated || prepared.progress.checksum !== checksum;
  const now = Date.now();

  if (!progressChanged && !retainedChanged) {
    const responseJson = JSON.stringify({
      ok: true,
      progress: publicPreparedProgress(prepared, manifest),
      unchanged: true
    });
    await commitArchiveProgressSync(env.DB, {
      uid,
      mutationId: incoming.clientMutationId,
      requestHash,
      responseJson,
      resultVersion: current.version,
      createdAt: now
    });
    return new Response(responseJson, {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  const nextProgress: ArchiveProgressState = {
    version: current.version + 1,
    revision: checksum,
    marker: encodeBase64(patched.bytes),
    checksum,
    archiveIndexHash: manifest.archiveIndexHash,
    formatVersion: manifest.formatVersion,
    bitsPerArchive: manifest.bitsPerArchive,
    archiveCount: manifest.archiveCount,
    retainedArchiveIds: patched.retainedArchiveIds,
    updatedAt: incoming.updatedAt
  };
  const responseJson = JSON.stringify({
    ok: true,
    progress: {
      revision: nextProgress.revision,
      archiveIndexHash: nextProgress.archiveIndexHash,
      updatedAt: nextProgress.updatedAt
    }
  });
  await commitArchiveProgressSync(env.DB, {
    uid,
    mutationId: incoming.clientMutationId,
    requestHash,
    responseJson,
    resultVersion: nextProgress.version,
    createdAt: now,
    progress: nextProgress
  });
  return new Response(responseJson, {
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
