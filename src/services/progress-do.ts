import { ApiError } from "../lib/errors";
import { getJsonFromKv, putJsonToKv, sha256Hex } from "../lib/kv-cache";
import { getUserByUid, updateProgressInD1 } from "../repositories/users";
import type { Bindings } from "../types/app";
import {
  PROGRESS_BITS_PER_POINT,
  PROGRESS_FORMAT_VERSION,
  buildProgressRevision,
  buildStatsCountsBase64,
  checksumProgressBitmap,
  diffOneBitBitmaps,
  emptyBitmapBytes,
  encodeBase64,
  getBitmapBit,
  isEmptyProgress,
  normalizeBitmapBytes,
  normalizeNonNegativeInt,
  nowTimestampMs,
  parseStatsCountsBase64,
  progressStateFromUser,
  publicProgressState,
  requireTimestampMs,
  setBitmapBit,
  type ProgressManifestPayload,
  type ProgressState,
  type ProgressStatsDelta,
  type ProgressStatsSnapshot,
  type ProgressSyncPayload,
  type PublicProgressState
} from "./progress";

type ProgressDoEnv = Bindings;

type RegisteredManifest = {
  markerIndexHash: string;
  formatVersion: number;
  bitsPerPoint: number;
  pointIds: string[];
  pointCount: number;
  indexById: Map<string, number>;
};

type StoredManifest = Omit<RegisteredManifest, "indexById">;

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

const STATS_STORAGE_KEY = "stats:snapshot:v1";
const STATS_D1_DIRTY_KEY = "stats:d1:dirty:v1";
const STATS_D1_FLUSH_ALARM_MS = 60_000;
const ACTIVE_MANIFEST_HASH_KEY = "progress:active-manifest-hash:v1";
const MANIFEST_KV_KEY_PREFIX = "progress:manifest:v1:";

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {})
    }
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonResponse(
      {
        code: error.code,
        message: error.message,
        details: error.details
      },
      { status: error.status }
    );
  }

  const message = error instanceof Error ? error.message : "Internal progress error.";
  return jsonResponse(
    {
      code: "PROGRESS_INTERNAL_ERROR",
      message
    },
    { status: 500 }
  );
}

function parseUid(url: URL): string {
  const uid = url.searchParams.get("uid")?.trim();
  if (!uid) {
    throw new ApiError(400, "PROGRESS_UID_REQUIRED", "Progress user id is required.");
  }
  return uid;
}

function normalizePointIds(value: unknown, fieldName: string): string[] {
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

function buildCanonicalMarkerManifest(pointIds: string[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    mapId: "endfield",
    points: pointIds
  });
}

function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

async function normalizeManifestPayload(raw: unknown): Promise<RegisteredManifest> {
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

function pointIdsFromBitmap(bytes: Uint8Array, manifest: RegisteredManifest): string[] {
  const pointIds: string[] = [];
  for (let index = 0; index < manifest.pointCount; index += 1) {
    if (getBitmapBit(bytes, index)) {
      const pointId = manifest.pointIds[index];
      if (pointId) pointIds.push(pointId);
    }
  }
  return pointIds;
}

function normalizeRetainedPointIds(pointIds: string[]): string[] {
  return [...new Set(pointIds.map((id) => String(id).trim()).filter(Boolean))];
}

function areStringArraysEqual(first: string[], second: string[]): boolean {
  if (first.length !== second.length) return false;
  const firstSet = new Set(first);
  return second.every((item) => firstSet.has(item));
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
    format: "bitmap-v1"
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

  private async loadManifest(markerIndexHash: string): Promise<RegisteredManifest | null> {
    const cached = await getJsonFromKv<StoredManifest>(
      this.env.OEM_KV,
      `${MANIFEST_KV_KEY_PREFIX}${markerIndexHash}`
    );
    if (cached) {
      return manifestFromStored(cached);
    }

    const row = await this.env.DB
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
      this.env.OEM_KV,
      `${MANIFEST_KV_KEY_PREFIX}${manifest.markerIndexHash}`,
      manifestToStored(manifest)
    ).catch(() => undefined);
    return manifest;
  }

  private async saveManifest(manifest: RegisteredManifest): Promise<void> {
    await this.env.DB
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
    await this.state.storage.put(ACTIVE_MANIFEST_HASH_KEY, manifest.markerIndexHash);
    await putJsonToKv(
      this.env.OEM_KV,
      `${MANIFEST_KV_KEY_PREFIX}${manifest.markerIndexHash}`,
      manifestToStored(manifest)
    ).catch(() => undefined);
  }

  private async loadActiveManifest(): Promise<RegisteredManifest> {
    const markerIndexHash = await this.state.storage.get<string>(ACTIVE_MANIFEST_HASH_KEY);
    if (!markerIndexHash) {
      throw new ApiError(409, "PROGRESS_MANIFEST_NOT_REGISTERED", "Progress manifest must be registered before sync.");
    }

    const manifest = await this.loadManifest(markerIndexHash);
    if (!manifest) {
      throw new ApiError(409, "PROGRESS_MANIFEST_NOT_REGISTERED", "Progress manifest must be registered before sync.");
    }

    return manifest;
  }

  private async publicProgress(
    progress: ProgressState,
    activeManifest?: RegisteredManifest
  ): Promise<PublicProgressState> {
    if (isEmptyProgress(progress)) {
      return emptyPublicProgress(progress.markerIndexHash);
    }

    const manifest = await this.loadManifest(progress.markerIndexHash);
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
    await this.saveManifest(manifest);
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
      const activeManifestHash = await this.state.storage.get<string>(ACTIVE_MANIFEST_HASH_KEY);
      return jsonResponse({ progress: emptyPublicProgress(activeManifestHash ?? progress.markerIndexHash) });
    }
    const activeManifest = await this.loadActiveManifest().catch(() => null);
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

    const sourceManifest = await this.loadManifest(progress.markerIndexHash);
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
    const manifest = await this.loadActiveManifest();

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

export class OEMStatsDO {
  private snapshot: ProgressStatsSnapshot | null = null;
  private counts: Uint32Array | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: ProgressDoEnv
  ) {
    void this.env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/state") {
        return await this.runExclusive(() => this.handleState(url));
      }

      if (request.method === "POST" && url.pathname === "/apply") {
        return await this.runExclusive(() => this.handleApply(request));
      }

      return jsonResponse({ code: "NOT_FOUND", message: "Progress stats DO route not found." }, { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async alarm(): Promise<void> {
    try {
      await this.runExclusive(() => this.flushSnapshotToD1IfDirty());
    } catch (error) {
      console.warn("[progress][stats] failed to flush snapshot to D1", {
        error: error instanceof Error ? error.message : String(error)
      });
      await this.state.storage.setAlarm(Date.now() + STATS_D1_FLUSH_ALARM_MS);
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

  private async loadSnapshot(markerIndexHash?: string): Promise<void> {
    if (this.snapshot && this.counts) return;
    const stored = await this.state.storage.get<ProgressStatsSnapshot>(STATS_STORAGE_KEY);
    if (stored) {
      this.snapshot = stored;
      this.counts = parseStatsCountsBase64(stored.counts, stored.pointCount);
      return;
    }

    const row = await this.env.DB
      .prepare(
        `SELECT marker_index_hash, point_count, total_synced_users, counts, updated_at
         FROM progress_stats_snapshots
         WHERE marker_index_hash = ?1
         LIMIT 1`
      )
      .bind(markerIndexHash ?? "")
      .first<{
        marker_index_hash: string;
        point_count: number;
        total_synced_users: number;
        counts: string;
        updated_at: number | null;
      }>();
    if (!row) return;

    const snapshot: ProgressStatsSnapshot = {
      markerIndexHash: row.marker_index_hash || "",
      pointCount: normalizeNonNegativeInt(row.point_count, 0),
      totalSyncedUsers: normalizeNonNegativeInt(row.total_synced_users, 0),
      counts: row.counts || "",
      updatedAt: row.updated_at ?? null
    };
    this.snapshot = snapshot;
    this.counts = parseStatsCountsBase64(snapshot.counts, snapshot.pointCount);
    await this.state.storage.put(STATS_STORAGE_KEY, snapshot);
  }

  private async saveSnapshotToStorage(): Promise<void> {
    if (!this.snapshot || !this.counts) return;
    const next: ProgressStatsSnapshot = {
      ...this.snapshot,
      counts: buildStatsCountsBase64(this.counts),
      updatedAt: nowTimestampMs()
    };
    this.snapshot = next;
    await this.state.storage.put(STATS_STORAGE_KEY, next);
  }

  private async markD1SnapshotDirty(): Promise<void> {
    await this.state.storage.put(STATS_D1_DIRTY_KEY, true);
    const currentAlarm = await this.state.storage.getAlarm();
    if (currentAlarm === null) {
      await this.state.storage.setAlarm(Date.now() + STATS_D1_FLUSH_ALARM_MS);
    }
  }

  private async writeSnapshotToD1(snapshot: ProgressStatsSnapshot): Promise<void> {
    await this.env.DB
      .prepare(
        `INSERT INTO progress_stats_snapshots
           (marker_index_hash, point_count, total_synced_users, counts, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(marker_index_hash) DO UPDATE SET
           point_count = excluded.point_count,
           total_synced_users = excluded.total_synced_users,
           counts = excluded.counts,
           updated_at = excluded.updated_at`
      )
      .bind(
        snapshot.markerIndexHash,
        snapshot.pointCount,
        snapshot.totalSyncedUsers,
        snapshot.counts,
        snapshot.updatedAt
      )
      .run();
  }

  private async flushSnapshotToD1IfDirty(): Promise<void> {
    const dirty = await this.state.storage.get<boolean>(STATS_D1_DIRTY_KEY);
    if (!dirty) return;

    await this.loadSnapshot();
    if (!this.snapshot) return;

    await this.writeSnapshotToD1(this.snapshot);
    await this.state.storage.delete(STATS_D1_DIRTY_KEY);
  }

  private async handleState(url: URL): Promise<Response> {
    const markerIndexHash = url.searchParams.get("markerIndexHash")?.trim().toLowerCase() ?? "";
    await this.loadSnapshot(markerIndexHash);
    if (!this.snapshot) {
      return jsonResponse({
        markerIndexHash,
        totalSyncedUsers: 0,
        sampleSize: 0,
        counts: "",
        updatedAt: null
      });
    }
    return jsonResponse({
      markerIndexHash: this.snapshot.markerIndexHash,
      totalSyncedUsers: this.snapshot.totalSyncedUsers,
      sampleSize: this.snapshot.totalSyncedUsers,
      counts: this.snapshot.counts,
      updatedAt: this.snapshot.updatedAt
    });
  }

  private async handleApply(request: Request): Promise<Response> {
    const payload = await request.json().catch(() => null) as Partial<ProgressStatsDelta> | null;
    if (!payload) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid progress stats delta.");
    }

    const markerIndexHash = typeof payload.markerIndexHash === "string" ? payload.markerIndexHash.trim().toLowerCase() : "";
    const pointCount = normalizeNonNegativeInt(payload.pointCount, 0);
    if (!isSha256Hex(markerIndexHash) || pointCount <= 0) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid progress stats metadata.");
    }

    await this.loadSnapshot(markerIndexHash);
    if (!this.snapshot || !this.counts) {
      this.counts = new Uint32Array(pointCount);
      this.snapshot = {
        markerIndexHash,
        pointCount,
        totalSyncedUsers: 0,
        counts: buildStatsCountsBase64(this.counts),
        updatedAt: null
      };
    }

    if (this.snapshot.markerIndexHash !== markerIndexHash || this.snapshot.pointCount !== pointCount) {
      throw new ApiError(409, "PROGRESS_STATS_DATASET_CONFLICT", "Stats dataset metadata does not match.");
    }

    const increments = Array.isArray(payload.increments) ? payload.increments : [];
    const decrements = Array.isArray(payload.decrements) ? payload.decrements : [];

    for (const index of increments) {
      if (!Number.isInteger(index) || index < 0 || index >= pointCount) continue;
      this.counts[index] = (this.counts[index] ?? 0) + 1;
    }

    for (const index of decrements) {
      if (!Number.isInteger(index) || index < 0 || index >= pointCount) continue;
      this.counts[index] = Math.max(0, (this.counts[index] ?? 0) - 1);
    }

    if (payload.firstSync) {
      this.snapshot.totalSyncedUsers += 1;
    }

    await this.saveSnapshotToStorage();
    await this.markD1SnapshotDirty();
    return jsonResponse({
      ok: true,
      markerIndexHash,
      totalSyncedUsers: this.snapshot.totalSyncedUsers,
      sampleSize: this.snapshot.totalSyncedUsers
    });
  }
}
