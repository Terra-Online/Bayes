import { ApiError } from "../../lib/errors";
import { getUserByUid } from "../../repositories/users";
import { sha256Hex } from "../../middleware/cache/kvJson";
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
  isSha256Hex,
  loadProgressManifest,
  normalizePointIds,
  pointIdsFromBitmap,
  type ProgressDoEnv,
  type RegisteredManifest
} from "./manifest";
import { drainUserProgressStatsOutbox } from "./outbox";
import { commitProgressSync, getProgressSyncMutation } from "./repository";
import { errorResponse, jsonResponse } from "./responses";

type NormalizedSyncPatch = {
  baseRevision: string;
  setPointIds: string[];
  clearPointIds: string[];
  clientMutationId: string;
  markerIndexHash: string;
  updatedAt: number;
};

type PreparedProgress = {
  progress: ProgressState;
  bytes: Uint8Array;
  retainedPointIds: string[];
  migrated: boolean;
};

function normalizeSyncPatch(raw: unknown): NormalizedSyncPatch {
  if (!raw || typeof raw !== "object") {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid progress sync payload.");
  }

  const payload = raw as ProgressSyncPayload;
  const baseRevision = typeof payload.baseRevision === "string" ? payload.baseRevision.trim().toLowerCase() : "";
  const clientMutationId = typeof payload.clientMutationId === "string" ? payload.clientMutationId.trim() : "";
  const markerIndexHash = typeof payload.markerIndexHash === "string"
    ? payload.markerIndexHash.trim().toLowerCase()
    : "";

  if (baseRevision && !isSha256Hex(baseRevision)) {
    throw new ApiError(422, "VALIDATION_ERROR", "baseRevision must be an opaque progress revision.");
  }
  if (!clientMutationId || clientMutationId.length > 128) {
    throw new ApiError(422, "VALIDATION_ERROR", "clientMutationId must contain between 1 and 128 characters.");
  }
  if (!isSha256Hex(markerIndexHash)) {
    throw new ApiError(422, "VALIDATION_ERROR", "markerIndexHash must be a SHA-256 hash.");
  }

  return {
    baseRevision,
    setPointIds: normalizePointIds(payload.setPointIds ?? [], "setPointIds"),
    clearPointIds: normalizePointIds(payload.clearPointIds ?? [], "clearPointIds"),
    clientMutationId,
    markerIndexHash,
    updatedAt: requireTimestampMs(payload.updatedAt, "updatedAt")
  };
}

function normalizeStateManifestHash(url: URL): string {
  const markerIndexHash = url.searchParams.get("markerIndexHash")?.trim().toLowerCase() ?? "";
  if (!isSha256Hex(markerIndexHash)) {
    throw new ApiError(422, "VALIDATION_ERROR", "markerIndexHash must be a SHA-256 hash.");
  }
  return markerIndexHash;
}

async function requireProgressManifest(
  env: ProgressDoEnv,
  markerIndexHash: string
): Promise<RegisteredManifest> {
  const manifest = await loadProgressManifest(env, markerIndexHash);
  if (!manifest) {
    throw new ApiError(409, "PROGRESS_MANIFEST_NOT_REGISTERED", "Progress manifest is not registered.");
  }
  return manifest;
}

async function buildSyncRequestHash(incoming: NormalizedSyncPatch): Promise<string> {
  return sha256Hex(JSON.stringify({
    baseRevision: incoming.baseRevision,
    markerIndexHash: incoming.markerIndexHash,
    setPointIds: [...incoming.setPointIds].sort(),
    clearPointIds: [...incoming.clearPointIds].sort(),
    updatedAt: incoming.updatedAt
  }));
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

export class OEMUserDO {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: ProgressDoEnv
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const startedAt = Date.now();
    let stage = "identity";

    try {
      const uid = this.state.id.name?.trim();
      if (!uid) {
        throw new ApiError(
          500,
          "PROGRESS_DO_IDENTITY_MISSING",
          "Progress Durable Object must be addressed by a named user id."
        );
      }

      if (request.method === "GET" && url.pathname === "/state") {
        stage = "state_manifest";
        const manifest = await requireProgressManifest(this.env, normalizeStateManifestHash(url));
        stage = "state_read";
        const response = await this.handleState(uid, manifest);
        console.warn("[progress][sync] request completed", {
          operation: "state",
          status: response.status,
          latencyMs: Date.now() - startedAt
        });
        return response;
      }

      if (request.method === "POST" && url.pathname === "/sync") {
        stage = "sync_parse";
        const incoming = normalizeSyncPatch(await request.json().catch(() => null));
        stage = "sync_prepare";
        const [manifest, requestHash, eventId] = await Promise.all([
          requireProgressManifest(this.env, incoming.markerIndexHash),
          buildSyncRequestHash(incoming),
          sha256Hex(`${uid}${incoming.clientMutationId}`)
        ]);
        stage = "sync_critical";
        const response = await this.runExclusive(
          () => this.handleSync(uid, incoming, requestHash, eventId, manifest)
        );
        console.warn("[progress][sync] request completed", {
          operation: "sync",
          status: response.status,
          latencyMs: Date.now() - startedAt
        });
        return response;
      }

      return jsonResponse({ code: "NOT_FOUND", message: "Progress DO route not found." }, { status: 404 });
    } catch (error) {
      console.error("[progress][sync] request failed", {
        path: url.pathname,
        stage,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
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

    const manifest = activeManifest?.markerIndexHash === progress.markerIndexHash
      ? activeManifest
      : await loadProgressManifest(this.env, progress.markerIndexHash);
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

  private async handleState(uid: string, manifest: RegisteredManifest): Promise<Response> {
    const user = await this.runExclusive(() => getUserByUid(this.env.DB, uid));
    const progress = progressStateFromUser(user);
    if (isEmptyProgress(progress)) {
      return jsonResponse({ progress: emptyPublicProgress(manifest.markerIndexHash) });
    }
    return jsonResponse({ progress: await this.publicProgress(progress, manifest) });
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

  private async handleSync(
    uid: string,
    incoming: NormalizedSyncPatch,
    requestHash: string,
    eventId: string,
    manifest: RegisteredManifest
  ): Promise<Response> {
    const existingMutation = await getProgressSyncMutation(
      this.env.DB,
      uid,
      incoming.clientMutationId
    );
    if (existingMutation) {
      if (existingMutation.requestHash !== requestHash) {
        throw new ApiError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "clientMutationId was already used for a different progress payload."
        );
      }
      console.warn("[progress][sync] idempotent replay", {
        uid,
        clientMutationId: incoming.clientMutationId,
        resultVersion: existingMutation.resultVersion
      });
      return new Response(existingMutation.responseJson, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-progress-idempotent": "true"
        }
      });
    }

    const user = await getUserByUid(this.env.DB, uid);
    if (!user) {
      throw new ApiError(404, "USER_NOT_FOUND", "User profile was not found.");
    }

    const current = progressStateFromUser(user);
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
      const responseJson = JSON.stringify({
        ok: true,
        progress: await this.publicProgress(prepared.progress, manifest),
        unchanged: true
      });
      const now = nowTimestampMs();
      await commitProgressSync(this.env.DB, {
        uid,
        mutationId: incoming.clientMutationId,
        requestHash,
        responseJson,
        resultVersion: current.version,
        createdAt: now
      });
      this.state.waitUntil(drainUserProgressStatsOutbox(this.env, uid));
      return new Response(responseJson, {
        headers: { "content-type": "application/json; charset=utf-8" }
      });
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

    const responseJson = JSON.stringify({
      ok: true,
      progress: {
        revision: nextProgress.revision,
        markerIndexHash: nextProgress.markerIndexHash,
        updatedAt: nextProgress.updatedAt
      }
    });
    const statsEvent: ProgressStatsDelta | undefined = firstSync
      || prepared.migrated
      || diff.increments.length > 0
      || diff.decrements.length > 0
      ? {
        eventId,
        markerIndexHash: manifest.markerIndexHash,
        pointCount: manifest.pointCount,
        increments: diff.increments,
        decrements: diff.decrements,
        firstSync: firstSync || prepared.migrated
      }
      : undefined;

    await commitProgressSync(this.env.DB, {
      uid,
      mutationId: incoming.clientMutationId,
      requestHash,
      responseJson,
      resultVersion: nextProgress.version,
      createdAt: now,
      progress: {
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
      },
      statsEvent
    });
    this.state.waitUntil(drainUserProgressStatsOutbox(this.env, uid));
    console.warn("[progress][sync] committed", {
      uid,
      mutationId: incoming.clientMutationId,
      version: nextProgress.version,
      statsEventId: statsEvent?.eventId ?? null
    });
    return new Response(responseJson, {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
}
