import { ApiError } from "../../lib/errors";
import { getUserByUid, updateProgressInD1 } from "../../repositories/users";
import {
  buildProgressRevision,
  isEmptyProgress,
  nowTimestampMs,
  PROGRESS_BITS_PER_POINT,
  PROGRESS_FORMAT_VERSION,
  PROGRESS_MARKER_FORMAT,
  progressStateFromUser,
  publicProgressState,
  requireTimestampMs,
  type ProgressState,
  type ProgressStatsDelta,
  type ProgressSyncPayload,
  type PublicProgressState
} from "./model";
import {
  checksumProgressBitmap,
  diffOneBitBitmaps,
  emptyBitmapBytes,
  encodeBase64,
  normalizeBitmapBytes,
  setBitmapBit
} from "./bitmap";
import {
  getActiveProgressManifestHash,
  isSha256Hex,
  loadActiveProgressManifest,
  loadProgressManifest,
  normalizeManifestPayload,
  normalizePointIds,
  pointIdsFromBitmap,
  saveProgressManifest,
  type ProgressDoEnv,
  type RegisteredManifest
} from "./manifest";
import { errorResponse, jsonResponse } from "./responses";

type NormalizedSyncPatch = {
  baseRevision: string;
  setPointIds: string[];
  clearPointIds: string[];
  clientMutationId: string | null;
  updatedAt: number;
};

type PreparedProgress = {
  progress: ProgressState;
  bytes: Uint8Array;
  retainedPointIds: string[];
  migrated: boolean;
};

function parseUid(url: URL): string {
  const uid = url.searchParams.get("uid")?.trim();
  if (!uid) {
    throw new ApiError(400, "PROGRESS_UID_REQUIRED", "Progress user id is required.");
  }
  return uid;
}

function normalizeSyncPatch(raw: unknown): NormalizedSyncPatch {
  if (!raw || typeof raw !== "object") {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid progress sync payload.");
  }

  const payload = raw as ProgressSyncPayload;
  const baseRevision = typeof payload.baseRevision === "string" ? payload.baseRevision.trim().toLowerCase() : "";
  const clientMutationId = typeof payload.clientMutationId === "string" && payload.clientMutationId.trim()
    ? payload.clientMutationId.trim().slice(0, 128)
    : null;

  if (baseRevision && !isSha256Hex(baseRevision)) {
    throw new ApiError(422, "VALIDATION_ERROR", "baseRevision must be an opaque progress revision.");
  }

  return {
    baseRevision,
    setPointIds: normalizePointIds(payload.setPointIds ?? [], "setPointIds"),
    clearPointIds: normalizePointIds(payload.clearPointIds ?? [], "clearPointIds"),
    clientMutationId,
    updatedAt: requireTimestampMs(payload.updatedAt, "updatedAt")
  };
}

function normalizeRetainedPointIds(pointIds: string[]): string[] {
  return [...new Set(pointIds.map((id) => String(id).trim()).filter(Boolean))];
}

function areStringArraysEqual(first: string[], second: string[]): boolean {
  if (first.length !== second.length) return false;
  const firstSet = new Set(first);
  return second.every((item) => firstSet.has(item));
}

function emptyPublicProgress(markerIndexHash = ""): PublicProgressState {
  return publicProgressState({
    version: 0,
    revision: "",
    marker: "",
    checksum: "",
    markerIndexHash,
    formatVersion: PROGRESS_FORMAT_VERSION,
    bitsPerPoint: PROGRESS_BITS_PER_POINT,
    pointCount: 0,
    updatedAt: null,
    format: PROGRESS_MARKER_FORMAT
  }, []);
}

async function applyStatsDelta(env: ProgressDoEnv, delta: ProgressStatsDelta): Promise<void> {
  if (!delta.firstSync && delta.increments.length === 0 && delta.decrements.length === 0) {
    return;
  }

  const stub = env.OEM_STATS_DO.get(env.OEM_STATS_DO.idFromName(delta.markerIndexHash));
  const response = await stub.fetch("https://progress-stats/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(delta)
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Progress stats update failed: ${response.status} ${message}`);
  }
}

export class OEMUserDO {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: ProgressDoEnv
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/state") {
        return await this.runExclusive(() => this.handleState(url));
      }

      if (request.method === "POST" && url.pathname === "/manifest") {
        return await this.runExclusive(() => this.handleManifest(request));
      }

      if (request.method === "POST" && url.pathname === "/sync") {
        return await this.runExclusive(() => this.handleSync(request, url));
      }

      return jsonResponse({ code: "NOT_FOUND", message: "Progress DO route not found." }, { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async publicProgress(
    progress: ProgressState,
    activeManifest?: RegisteredManifest
  ): Promise<PublicProgressState> {
    if (isEmptyProgress(progress)) {
      return emptyPublicProgress(progress.markerIndexHash);
    }

    const manifest = await loadProgressManifest(this.env, progress.markerIndexHash);
    if (!manifest) {
      throw new ApiError(409, "PROGRESS_MANIFEST_NOT_REGISTERED", "Progress manifest is not registered.");
    }

    const bytes = normalizeBitmapBytes(progress.marker, manifest.pointCount, manifest.bitsPerPoint);
    const pointIds = pointIdsFromBitmap(bytes, manifest);
    if (!activeManifest) {
      return publicProgressState(progress, pointIds);
    }

    return publicProgressState(
      progress,
      pointIds.filter((pointId) => activeManifest.indexById.has(pointId))
    );
  }

  private async handleManifest(request: Request): Promise<Response> {
    const manifest = await normalizeManifestPayload(await request.json().catch(() => null));
    await saveProgressManifest(this.env, this.state, manifest);
    return jsonResponse({
      ok: true,
      manifest: {
        markerIndexHash: manifest.markerIndexHash
      }
    });
  }

  private async handleState(url: URL): Promise<Response> {
    const uid = parseUid(url);
    const user = await getUserByUid(this.env.DB, uid);
    const progress = progressStateFromUser(user);
    if (isEmptyProgress(progress)) {
      const activeManifestHash = await getActiveProgressManifestHash(this.state);
      return jsonResponse({ progress: emptyPublicProgress(activeManifestHash ?? progress.markerIndexHash) });
    }
    const activeManifest = await loadActiveProgressManifest(this.env, this.state).catch(() => null);
    return jsonResponse({ progress: await this.publicProgress(progress, activeManifest ?? undefined) });
  }

  private async prepareProgressForManifest(
    progress: ProgressState,
    retainedPointIds: string[],
    targetManifest: RegisteredManifest
  ): Promise<PreparedProgress> {
    const retained = new Set(normalizeRetainedPointIds(retainedPointIds));

    if (isEmptyProgress(progress)) {
      return {
        progress,
        bytes: emptyBitmapBytes(targetManifest.pointCount, targetManifest.bitsPerPoint),
        retainedPointIds: [...retained],
        migrated: false
      };
    }

    const sameManifest = progress.markerIndexHash === targetManifest.markerIndexHash
      && progress.formatVersion === targetManifest.formatVersion
      && progress.bitsPerPoint === targetManifest.bitsPerPoint
      && progress.pointCount === targetManifest.pointCount;

    if (sameManifest) {
      return {
        progress,
        bytes: normalizeBitmapBytes(progress.marker, targetManifest.pointCount, targetManifest.bitsPerPoint),
        retainedPointIds: [...retained],
        migrated: false
      };
    }

    const sourceManifest = await loadProgressManifest(this.env, progress.markerIndexHash);
    if (!sourceManifest) {
      throw new ApiError(
        409,
        "PROGRESS_MANIFEST_NOT_REGISTERED",
        "Current cloud progress manifest is not registered."
      );
    }

    const sourceBytes = normalizeBitmapBytes(progress.marker, sourceManifest.pointCount, sourceManifest.bitsPerPoint);
    const nextBytes = emptyBitmapBytes(targetManifest.pointCount, targetManifest.bitsPerPoint);
    for (const pointId of pointIdsFromBitmap(sourceBytes, sourceManifest)) {
      const nextIndex = targetManifest.indexById.get(pointId);
      if (nextIndex === undefined) {
        retained.add(pointId);
        continue;
      }
      setBitmapBit(nextBytes, nextIndex, true);
    }

    const checksum = await checksumProgressBitmap(nextBytes, {
      markerIndexHash: targetManifest.markerIndexHash,
      formatVersion: targetManifest.formatVersion,
      bitsPerPoint: targetManifest.bitsPerPoint,
      pointCount: targetManifest.pointCount
    });

    return {
      progress: {
        ...progress,
        revision: buildProgressRevision(checksum),
        marker: encodeBase64(nextBytes),
        checksum,
        markerIndexHash: targetManifest.markerIndexHash,
        formatVersion: targetManifest.formatVersion,
        bitsPerPoint: targetManifest.bitsPerPoint,
        pointCount: targetManifest.pointCount
      },
      bytes: nextBytes,
      retainedPointIds: [...retained],
      migrated: true
    };
  }

  private async handleSync(request: Request, url: URL): Promise<Response> {
    const uid = parseUid(url);
    const incoming = normalizeSyncPatch(await request.json().catch(() => null));
    const manifest = await loadActiveProgressManifest(this.env, this.state);

    const user = await getUserByUid(this.env.DB, uid);
    if (!user) {
      throw new ApiError(404, "USER_NOT_FOUND", "User profile was not found.");
    }

    const current = progressStateFromUser(user);
    if (
      incoming.clientMutationId
      && user.progressLastMutationId
      && incoming.clientMutationId === user.progressLastMutationId
    ) {
      return jsonResponse({ ok: true, progress: await this.publicProgress(current, manifest), idempotent: true });
    }

    const prepared = await this.prepareProgressForManifest(
      current,
      user.progressRetainedPointIds,
      manifest
    );

    if (
      incoming.baseRevision !== current.revision
      && incoming.baseRevision !== prepared.progress.revision
    ) {
      throw new ApiError(
        409,
        "PROGRESS_REVISION_CONFLICT",
        "Incoming patch is based on an older cloud revision.",
        { current: await this.publicProgress(prepared.progress, manifest) }
      );
    }

    const currentBytes = prepared.bytes;
    const nextBytes = new Uint8Array(currentBytes);
    const retainedPointIds = new Set(prepared.retainedPointIds);

    for (const pointId of incoming.clearPointIds) {
      const index = manifest.indexById.get(pointId);
      if (index === undefined) continue;
      setBitmapBit(nextBytes, index, false);
    }
    for (const pointId of incoming.setPointIds) {
      const index = manifest.indexById.get(pointId);
      if (index === undefined) {
        retainedPointIds.add(pointId);
        continue;
      }
      setBitmapBit(nextBytes, index, true);
    }

    const computedChecksum = await checksumProgressBitmap(nextBytes, {
      markerIndexHash: manifest.markerIndexHash,
      formatVersion: manifest.formatVersion,
      bitsPerPoint: manifest.bitsPerPoint,
      pointCount: manifest.pointCount
    });

    const nextRetainedPointIds = normalizeRetainedPointIds([...retainedPointIds]);
    const retainedChanged = !areStringArraysEqual(
      normalizeRetainedPointIds(user.progressRetainedPointIds),
      nextRetainedPointIds
    );
    const progressChanged = prepared.migrated || prepared.progress.checksum !== computedChecksum;

    if (!progressChanged && !retainedChanged) {
      return jsonResponse({ ok: true, progress: await this.publicProgress(prepared.progress, manifest), unchanged: true });
    }

    const diff = prepared.migrated
      ? diffOneBitBitmaps(
        emptyBitmapBytes(manifest.pointCount, manifest.bitsPerPoint),
        nextBytes,
        manifest.pointCount
      )
      : diffOneBitBitmaps(currentBytes, nextBytes, manifest.pointCount);
    const now = nowTimestampMs();
    const nextProgress: ProgressState = {
      version: current.version + 1,
      revision: buildProgressRevision(computedChecksum),
      marker: encodeBase64(nextBytes),
      checksum: computedChecksum,
      markerIndexHash: manifest.markerIndexHash,
      formatVersion: manifest.formatVersion,
      bitsPerPoint: manifest.bitsPerPoint,
      pointCount: manifest.pointCount,
      updatedAt: incoming.updatedAt ?? now,
      format: current.format
    };
    const firstSync = !user.progressCloudSynced;

    await updateProgressInD1(this.env.DB, uid, {
      version: nextProgress.version,
      marker: nextProgress.marker,
      checksum: nextProgress.checksum,
      markerIndexHash: nextProgress.markerIndexHash,
      formatVersion: nextProgress.formatVersion,
      bitsPerPoint: nextProgress.bitsPerPoint,
      pointCount: nextProgress.pointCount,
      retainedPointIds: nextRetainedPointIds,
      updatedAt: nextProgress.updatedAt ?? now,
      clientMutationId: incoming.clientMutationId,
      cloudSynced: true,
      syncedAt: firstSync ? now : null
    });

    try {
      await applyStatsDelta(this.env, {
        markerIndexHash: manifest.markerIndexHash,
        pointCount: manifest.pointCount,
        increments: diff.increments,
        decrements: diff.decrements,
        firstSync: firstSync || prepared.migrated
      });
    } catch (error) {
      console.warn("[progress][stats] failed to apply delta", {
        uid,
        markerIndexHash: manifest.markerIndexHash,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return jsonResponse({
      ok: true,
      progress: {
        revision: nextProgress.revision,
        markerIndexHash: nextProgress.markerIndexHash,
        updatedAt: nextProgress.updatedAt
      }
    });
  }
}
