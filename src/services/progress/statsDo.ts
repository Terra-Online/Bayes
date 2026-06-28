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

const STATS_STORAGE_KEY = "stats:snapshot:v1";
const STATS_D1_DIRTY_KEY = "stats:d1:dirty:v1";
const STATS_D1_FLUSH_ALARM_MS = 60_000;

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
