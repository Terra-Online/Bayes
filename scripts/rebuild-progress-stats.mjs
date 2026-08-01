import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const wranglerPath = resolve(repositoryRoot, "node_modules/.bin/wrangler");
const args = new Set(process.argv.slice(2));
const mode = args.has("--remote") ? "--remote" : args.has("--local") ? "--local" : null;
const MAX_WRANGLER_ATTEMPTS = 5;

if (!mode || (args.has("--remote") && args.has("--local"))) {
  throw new Error("Specify exactly one target: --local or --remote.");
}

function executeWrangler(arguments_, options) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_WRANGLER_ATTEMPTS; attempt += 1) {
    try {
      return execFileSync(wranglerPath, arguments_, options);
    } catch (error) {
      lastError = error;
      const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
      const retryable = output.includes("Authentication error")
        || output.includes("fetch failed")
        || output.includes("network");
      if (!retryable || attempt >= MAX_WRANGLER_ATTEMPTS) break;
      console.warn(`Wrangler attempt ${attempt} failed; retrying D1 operation.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 1_000);
    }
  }
  throw lastError;
}

function executeJson(command) {
  const output = executeWrangler(
    ["d1", "execute", "DB", mode, "--json", "--command", command],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const payload = JSON.parse(output);
  const operations = Array.isArray(payload) ? payload : [payload];
  return operations.flatMap((operation) => operation.results ?? []);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const outboxHealth = executeJson(
  `SELECT
     SUM(CASE WHEN status IN ('pending', 'retry') THEN 1 ELSE 0 END) AS pending,
     SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
   FROM progress_stats_outbox`
)[0] ?? {};
if (Number(outboxHealth.pending ?? 0) > 0 || Number(outboxHealth.blocked ?? 0) > 0) {
  throw new Error(
    `Outbox is not caught up (pending=${outboxHealth.pending ?? 0}, blocked=${outboxHealth.blocked ?? 0}).`
  );
}

const manifests = executeJson(
  `SELECT marker_index_hash, point_count
   FROM progress_marker_manifests
   ORDER BY marker_index_hash`
);
const snapshots = new Map(manifests.map((row) => {
  const markerIndexHash = String(row.marker_index_hash);
  const pointCount = Number(row.point_count);
  return [markerIndexHash, {
    markerIndexHash,
    pointCount,
    totalSyncedUsers: 0,
    counts: new Uint32Array(pointCount)
  }];
}));

let cursor = 0;
let rebuiltUsers = 0;
while (true) {
  const rows = executeJson(
    `SELECT rowid, progress_marker_index_hash, progress_marker, progress_point_count
     FROM users
     WHERE progress_cloud_synced = 1 AND rowid > ${cursor}
     ORDER BY rowid ASC
     LIMIT 1000`
  );
  if (rows.length === 0) break;

  for (const row of rows) {
    cursor = Math.max(cursor, Number(row.rowid));
    const markerIndexHash = String(row.progress_marker_index_hash ?? "");
    const snapshot = snapshots.get(markerIndexHash);
    if (!snapshot) {
      throw new Error(`User row ${row.rowid} references unregistered manifest ${markerIndexHash}.`);
    }
    if (Number(row.progress_point_count) !== snapshot.pointCount) {
      throw new Error(`User row ${row.rowid} has a point count that differs from its manifest.`);
    }

    const marker = Buffer.from(String(row.progress_marker ?? ""), "base64");
    const expectedBytes = Math.ceil(snapshot.pointCount / 8);
    if (marker.length !== expectedBytes) {
      throw new Error(`User row ${row.rowid} has an invalid progress bitmap length.`);
    }
    snapshot.totalSyncedUsers += 1;
    rebuiltUsers += 1;
    for (let pointIndex = 0; pointIndex < snapshot.pointCount; pointIndex += 1) {
      if ((marker[Math.floor(pointIndex / 8)] & (1 << (pointIndex % 8))) !== 0) {
        snapshot.counts[pointIndex] += 1;
      }
    }
  }
}

const now = Date.now();
const statements = [];
for (const snapshot of snapshots.values()) {
  const counts = Buffer.alloc(snapshot.pointCount * Uint32Array.BYTES_PER_ELEMENT);
  snapshot.counts.forEach((count, index) => counts.writeUInt32LE(count, index * 4));
  statements.push(
    `INSERT INTO progress_stats_snapshots
       (marker_index_hash, point_count, total_synced_users, counts, updated_at, snapshot_version)
     VALUES (${sqlString(snapshot.markerIndexHash)}, ${snapshot.pointCount}, ${snapshot.totalSyncedUsers},
             ${sqlString(counts.toString("base64"))}, ${now}, 2)
     ON CONFLICT(marker_index_hash) DO UPDATE SET
       point_count = excluded.point_count,
       total_synced_users = excluded.total_synced_users,
       counts = excluded.counts,
       updated_at = excluded.updated_at,
       snapshot_version = excluded.snapshot_version;`
  );
}
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "oem-progress-stats-"));
const sqlPath = resolve(temporaryDirectory, "rebuild.sql");
try {
  writeFileSync(sqlPath, `${statements.join("\n")}\n`);
  executeWrangler(
    ["d1", "execute", "DB", mode, "--file", sqlPath, "--yes"],
    { cwd: repositoryRoot, stdio: "inherit" }
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

const stored = executeJson(
  `SELECT marker_index_hash, point_count, total_synced_users, counts
   FROM progress_stats_snapshots
   WHERE snapshot_version = 2
   ORDER BY marker_index_hash`
);
for (const row of stored) {
  const expected = snapshots.get(String(row.marker_index_hash));
  if (!expected) continue;
  const counts = Buffer.alloc(expected.pointCount * Uint32Array.BYTES_PER_ELEMENT);
  expected.counts.forEach((count, index) => counts.writeUInt32LE(count, index * 4));
  if (
    Number(row.point_count) !== expected.pointCount
    || Number(row.total_synced_users) !== expected.totalSyncedUsers
    || String(row.counts) !== counts.toString("base64")
  ) {
    throw new Error(`Rebuild verification failed for manifest ${expected.markerIndexHash}.`);
  }
}
if (stored.length !== snapshots.size) {
  throw new Error(`Rebuild verification expected ${snapshots.size} snapshots but found ${stored.length}.`);
}

console.log(`Rebuilt ${snapshots.size} progress stats snapshots from ${rebuiltUsers} synced users.`);
