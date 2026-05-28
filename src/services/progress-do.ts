import { ApiError } from "../lib/errors";
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

type NormalizedSyncPatch = {
  baseRevision: string;
  setPointIds: string[];
  clearPointIds: string[];
  clientMutationId: string | null;
  updatedAt: number;
};

const STATS_STORAGE_KEY = "stats:snapshot:v1";
const STATS_D1_DIRTY_KEY = "stats:d1:dirty:v1";
const STATS_D1_FLUSH_ALARM_MS = 60_000;
const ACTIVE_MANIFEST_HASH_KEY = "progress:active-manifest-hash:v1";

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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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

  const stub = env.PROGRESS_STATS_DO.get(env.PROGRESS_STATS_DO.idFromName(delta.markerIndexHash));
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

export class ProgressUserDO {
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
    return {
      markerIndexHash: row.marker_index_hash,
      formatVersion: normalizeNonNegativeInt(row.format_version, PROGRESS_FORMAT_VERSION),
      bitsPerPoint: normalizeNonNegativeInt(row.bits_per_point, PROGRESS_BITS_PER_POINT),
      pointCount: normalizeNonNegativeInt(row.point_count, pointIds.length),
      pointIds,
      indexById: new Map(pointIds.map((id, index) => [id, index]))
    };
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

  private async publicProgress(progress: ProgressState): Promise<PublicProgressState> {
    if (isEmptyProgress(progress)) {
      return emptyPublicProgress(progress.markerIndexHash);
    }

    const manifest = await this.loadManifest(progress.markerIndexHash);
    if (!manifest) {
      throw new ApiError(409, "PROGRESS_MANIFEST_NOT_REGISTERED", "Progress manifest is not registered.");
    }

    const bytes = normalizeBitmapBytes(progress.marker, manifest.pointCount, manifest.bitsPerPoint);
    return publicProgressState(progress, pointIdsFromBitmap(bytes, manifest));
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
    return jsonResponse({ progress: await this.publicProgress(progress) });
  }

  private pointIndicesForPatch(pointIds: string[], manifest: RegisteredManifest, fieldName: string): number[] {
    return pointIds.map((pointId) => {
      const index = manifest.indexById.get(pointId);
      if (index === undefined) {
        throw new ApiError(422, "UNKNOWN_PROGRESS_POINT", `Unknown point id in ${fieldName}.`, { pointId });
      }
      return index;
    });
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
      return jsonResponse({ ok: true, progress: await this.publicProgress(current), idempotent: true });
    }

    if (
      !isEmptyProgress(current)
      && (
        current.markerIndexHash !== manifest.markerIndexHash
        || current.formatVersion !== manifest.formatVersion
        || current.bitsPerPoint !== manifest.bitsPerPoint
        || current.pointCount !== manifest.pointCount
      )
    ) {
      throw new ApiError(
        409,
        "PROGRESS_MANIFEST_CONFLICT",
        "Current cloud progress was encoded with a different marker index.",
        { current: await this.publicProgress(current) }
      );
    }

    if (incoming.baseRevision !== current.revision) {
      throw new ApiError(
        409,
        "PROGRESS_REVISION_CONFLICT",
        "Incoming patch is based on an older cloud revision.",
        { current: await this.publicProgress(current) }
      );
    }

    const currentBytes = isEmptyProgress(current)
      ? emptyBitmapBytes(manifest.pointCount, manifest.bitsPerPoint)
      : normalizeBitmapBytes(current.marker, manifest.pointCount, manifest.bitsPerPoint);
    const nextBytes = new Uint8Array(currentBytes);

    for (const index of this.pointIndicesForPatch(incoming.clearPointIds, manifest, "clearPointIds")) {
      setBitmapBit(nextBytes, index, false);
    }
    for (const index of this.pointIndicesForPatch(incoming.setPointIds, manifest, "setPointIds")) {
      setBitmapBit(nextBytes, index, true);
    }

    const computedChecksum = await checksumProgressBitmap(nextBytes, {
      markerIndexHash: manifest.markerIndexHash,
      formatVersion: manifest.formatVersion,
      bitsPerPoint: manifest.bitsPerPoint,
      pointCount: manifest.pointCount
    });

    if (current.checksum && current.checksum === computedChecksum) {
      return jsonResponse({ ok: true, progress: await this.publicProgress(current), unchanged: true });
    }

    const diff = diffOneBitBitmaps(currentBytes, nextBytes, manifest.pointCount);
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
        firstSync
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

export class ProgressStatsDO {
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
