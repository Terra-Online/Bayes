import { ApiError } from "../../lib/errors";
import {
  normalizeNonNegativeInt,
  nowTimestampMs,
  type ProgressStatsDelta,
  type ProgressStatsSnapshot
} from "./model";
import { buildStatsCountsBase64, parseStatsCountsBase64 } from "./bitmap";
import { isSha256Hex, type ProgressDoEnv } from "./manifest";
import { errorResponse, jsonResponse } from "./responses";

const STATS_STORAGE_KEY = "stats:snapshot:v2";
const STATS_D1_DIRTY_KEY = "stats:d1:dirty:v2";
const STATS_EVENT_KEY_PREFIX = "stats:event:v2:";
const STATS_EVENT_EXPIRY_KEY_PREFIX = "stats:event-expiry:v2:";
const STATS_D1_FLUSH_ALARM_MS = 60_000;
const STATS_RECEIPT_RETENTION_MS = 45 * 24 * 60 * 60 * 1_000;
const STATS_RECEIPT_CLEANUP_LIMIT = 256;
const STATS_SNAPSHOT_VERSION = 2;

function receiptKey(eventId: string): string {
  return `${STATS_EVENT_KEY_PREFIX}${eventId}`;
}

function receiptExpiryKey(eventId: string, appliedAt: number): string {
  const expiresAt = appliedAt + STATS_RECEIPT_RETENTION_MS;
  return `${STATS_EVENT_EXPIRY_KEY_PREFIX}${String(expiresAt).padStart(13, "0")}:${eventId}`;
}

function parseReceiptExpiry(key: string): number | null {
  const value = key.slice(STATS_EVENT_EXPIRY_KEY_PREFIX.length).split(":", 1)[0];
  const expiresAt = Number(value);
  return Number.isFinite(expiresAt) ? expiresAt : null;
}

function eventIdFromExpiryKey(key: string): string {
  return key.slice(STATS_EVENT_EXPIRY_KEY_PREFIX.length + 14);
}

export class OEMStatsDO {
  private snapshot: ProgressStatsSnapshot | null = null;
  private counts: Uint32Array | null = null;
  private d1SnapshotChecked = false;
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
      await this.runExclusive(async () => {
        await this.flushSnapshotToD1IfDirty();
        const nextExpiry = await this.cleanupExpiredReceipts();
        if (nextExpiry !== null) {
          await this.state.storage.setAlarm(Math.max(Date.now() + 1_000, nextExpiry));
        }
      });
    } catch (error) {
      console.warn("[progress][stats] alarm failed", {
        markerIndexHash: this.state.id.name ?? null,
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

  private requireObjectManifestHash(markerIndexHash: string): void {
    const objectName = this.state.id.name?.trim().toLowerCase();
    if (!objectName) {
      throw new ApiError(
        500,
        "PROGRESS_STATS_DO_IDENTITY_MISSING",
        "Progress Stats Durable Object must be addressed by a named manifest hash."
      );
    }
    if (objectName !== markerIndexHash) {
      throw new ApiError(
        409,
        "PROGRESS_STATS_DATASET_CONFLICT",
        "Stats event was routed to a different manifest Durable Object."
      );
    }
  }

  private async loadD1Snapshot(markerIndexHash: string): Promise<ProgressStatsSnapshot | null> {
    const row = await this.env.DB
      .prepare(
        `SELECT marker_index_hash, point_count, total_synced_users, counts, updated_at
         FROM progress_stats_snapshots
         WHERE marker_index_hash = ?1 AND snapshot_version = ?2
         LIMIT 1`
      )
      .bind(markerIndexHash, STATS_SNAPSHOT_VERSION)
      .first<{
        marker_index_hash: string;
        point_count: number;
        total_synced_users: number;
        counts: string;
        updated_at: number | null;
      }>();
    if (!row) return null;

    return {
      markerIndexHash: row.marker_index_hash || "",
      pointCount: normalizeNonNegativeInt(row.point_count, 0),
      totalSyncedUsers: normalizeNonNegativeInt(row.total_synced_users, 0),
      counts: row.counts || "",
      updatedAt: row.updated_at ?? null
    };
  }

  private async loadSnapshot(markerIndexHash: string): Promise<void> {
    if (this.d1SnapshotChecked) return;

    const stored = this.snapshot
      ?? await this.state.storage.get<ProgressStatsSnapshot>(STATS_STORAGE_KEY)
      ?? null;
    const fromD1 = await this.loadD1Snapshot(markerIndexHash);
    const storedUpdatedAt = stored?.updatedAt ?? 0;
    const d1UpdatedAt = fromD1?.updatedAt ?? 0;
    const snapshot = fromD1 && (!stored || d1UpdatedAt > storedUpdatedAt)
      ? fromD1
      : stored;

    if (snapshot) {
      if (snapshot === fromD1) {
        await this.state.storage.transaction(async (transaction) => {
          await transaction.put(STATS_STORAGE_KEY, snapshot);
          await transaction.delete(STATS_D1_DIRTY_KEY);
        });
        console.warn("[progress][stats] loaded newer authoritative D1 snapshot", {
          markerIndexHash,
          previousUpdatedAt: stored?.updatedAt ?? null,
          rebuiltUpdatedAt: snapshot.updatedAt,
          totalSyncedUsers: snapshot.totalSyncedUsers
        });
      }
      this.snapshot = snapshot;
      this.counts = parseStatsCountsBase64(snapshot.counts, snapshot.pointCount);
    }
    this.d1SnapshotChecked = true;
  }

  private async ensureMaintenanceAlarm(): Promise<void> {
    const nextFlushAt = Date.now() + STATS_D1_FLUSH_ALARM_MS;
    const currentAlarm = await this.state.storage.getAlarm();
    if (currentAlarm === null || currentAlarm > nextFlushAt) {
      await this.state.storage.setAlarm(nextFlushAt);
    }
  }

  private async writeSnapshotToD1(snapshot: ProgressStatsSnapshot): Promise<void> {
    await this.env.DB
      .prepare(
        `INSERT INTO progress_stats_snapshots
           (marker_index_hash, point_count, total_synced_users, counts, updated_at, snapshot_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(marker_index_hash) DO UPDATE SET
           point_count = excluded.point_count,
           total_synced_users = excluded.total_synced_users,
           counts = excluded.counts,
           updated_at = excluded.updated_at,
           snapshot_version = excluded.snapshot_version`
      )
      .bind(
        snapshot.markerIndexHash,
        snapshot.pointCount,
        snapshot.totalSyncedUsers,
        snapshot.counts,
        snapshot.updatedAt,
        STATS_SNAPSHOT_VERSION
      )
      .run();
  }

  private async flushSnapshotToD1IfDirty(): Promise<void> {
    const dirty = await this.state.storage.get<boolean>(STATS_D1_DIRTY_KEY);
    if (!dirty) return;

    const markerIndexHash = this.state.id.name?.trim().toLowerCase() ?? "";
    await this.loadSnapshot(markerIndexHash);
    if (!this.snapshot) return;

    await this.writeSnapshotToD1(this.snapshot);
    await this.state.storage.delete(STATS_D1_DIRTY_KEY);
  }

  private async cleanupExpiredReceipts(): Promise<number | null> {
    const now = Date.now();
    const expiryEntries = await this.state.storage.list<number>({
      prefix: STATS_EVENT_EXPIRY_KEY_PREFIX,
      limit: STATS_RECEIPT_CLEANUP_LIMIT
    });
    const keysToDelete: string[] = [];
    let nextExpiry: number | null = null;

    for (const key of expiryEntries.keys()) {
      const expiresAt = parseReceiptExpiry(key);
      if (expiresAt === null) {
        keysToDelete.push(key);
        continue;
      }
      if (expiresAt > now) {
        nextExpiry = expiresAt;
        break;
      }
      keysToDelete.push(key, receiptKey(eventIdFromExpiryKey(key)));
    }

    if (keysToDelete.length > 0) {
      await this.state.storage.delete(keysToDelete);
    }
    if (expiryEntries.size === STATS_RECEIPT_CLEANUP_LIMIT && nextExpiry === null) {
      return now + 1_000;
    }
    return nextExpiry;
  }

  private async handleState(url: URL): Promise<Response> {
    const markerIndexHash = url.searchParams.get("markerIndexHash")?.trim().toLowerCase() ?? "";
    if (!isSha256Hex(markerIndexHash)) {
      throw new ApiError(422, "VALIDATION_ERROR", "markerIndexHash must be a SHA-256 hash.");
    }
    this.requireObjectManifestHash(markerIndexHash);
    await this.loadSnapshot(markerIndexHash);
    if (!this.snapshot) {
      return jsonResponse({
        markerIndexHash,
        pointCount: 0,
        totalSyncedUsers: 0,
        sampleSize: 0,
        counts: "",
        updatedAt: null
      });
    }
    return jsonResponse({
      markerIndexHash: this.snapshot.markerIndexHash,
      pointCount: this.snapshot.pointCount,
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

    const eventId = typeof payload.eventId === "string" ? payload.eventId.trim().toLowerCase() : "";
    const markerIndexHash = typeof payload.markerIndexHash === "string"
      ? payload.markerIndexHash.trim().toLowerCase()
      : "";
    const pointCount = normalizeNonNegativeInt(payload.pointCount, 0);
    if (!isSha256Hex(eventId) || !isSha256Hex(markerIndexHash) || pointCount <= 0) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid progress stats event metadata.");
    }
    this.requireObjectManifestHash(markerIndexHash);

    await this.loadSnapshot(markerIndexHash);
    const currentSnapshot = this.snapshot ?? {
      markerIndexHash,
      pointCount,
      totalSyncedUsers: 0,
      counts: buildStatsCountsBase64(new Uint32Array(pointCount)),
      updatedAt: null
    };
    const currentCounts = this.counts ?? new Uint32Array(pointCount);

    if (currentSnapshot.markerIndexHash !== markerIndexHash || currentSnapshot.pointCount !== pointCount) {
      throw new ApiError(409, "PROGRESS_STATS_DATASET_CONFLICT", "Stats dataset metadata does not match.");
    }

    const increments = Array.isArray(payload.increments) ? payload.increments : [];
    const decrements = Array.isArray(payload.decrements) ? payload.decrements : [];
    const nextCounts = new Uint32Array(currentCounts);
    for (const index of increments) {
      if (!Number.isInteger(index) || index < 0 || index >= pointCount) continue;
      nextCounts[index] = (nextCounts[index] ?? 0) + 1;
    }
    for (const index of decrements) {
      if (!Number.isInteger(index) || index < 0 || index >= pointCount) continue;
      nextCounts[index] = Math.max(0, (nextCounts[index] ?? 0) - 1);
    }

    const appliedAt = nowTimestampMs();
    const nextSnapshot: ProgressStatsSnapshot = {
      markerIndexHash,
      pointCount,
      totalSyncedUsers: currentSnapshot.totalSyncedUsers + (payload.firstSync ? 1 : 0),
      counts: buildStatsCountsBase64(nextCounts),
      updatedAt: appliedAt
    };
    let duplicate = false;
    await this.state.storage.transaction(async (transaction) => {
      const existingReceipt = await transaction.get<number>(receiptKey(eventId));
      if (existingReceipt !== undefined) {
        duplicate = true;
        return;
      }
      await transaction.put(STATS_STORAGE_KEY, nextSnapshot);
      await transaction.put(receiptKey(eventId), appliedAt);
      await transaction.put(receiptExpiryKey(eventId, appliedAt), appliedAt);
      await transaction.put(STATS_D1_DIRTY_KEY, true);
    });

    await this.ensureMaintenanceAlarm();
    if (duplicate) {
      console.warn("[progress][stats] duplicate event", { eventId, markerIndexHash });
      return jsonResponse({
        ok: true,
        idempotent: true,
        markerIndexHash,
        totalSyncedUsers: currentSnapshot.totalSyncedUsers,
        sampleSize: currentSnapshot.totalSyncedUsers
      });
    }

    this.snapshot = nextSnapshot;
    this.counts = nextCounts;
    return jsonResponse({
      ok: true,
      markerIndexHash,
      totalSyncedUsers: nextSnapshot.totalSyncedUsers,
      sampleSize: nextSnapshot.totalSyncedUsers
    });
  }
}
