import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const MARKER_DATA_DIR = process.env.ATLOS_MARKER_DATA_DIR
  ?? path.resolve(ROOT, "../Atlos/talos/src/data/marker/data");
const CACHE_DIR = path.resolve(ROOT, ".cache/demo-ugc");
const IMAGE_DIR = path.join(CACHE_DIR, "images");
const STATE_FILE = path.join(CACHE_DIR, "state.json");
const SQL_FILE = path.join(CACHE_DIR, "import.sql");
const KV_DELETE_FILE = path.join(CACHE_DIR, "kv-delete.json");
const REMOTE_API = "https://api.opendfieldmap.org/uploads/v1/images";
const BATCH_SIZE = 30;
const DOWNLOAD_CONCURRENCY = 60;
const IMPORT_CONCURRENCY = 20;
const DEMO_USER_ID = "demo-r2-sync";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sql = (value) => `'${String(value ?? "").replaceAll("'", "''")}'`;

async function fetchWithRetry(url, init = {}, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;
      const body = await response.text();
      lastError = new Error(`${response.status} ${body}`);
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after") ?? 0);
        let bodyRetryAfter = 0;
        try {
          bodyRetryAfter = Number(JSON.parse(body)?.details?.retryAfterSeconds ?? 0);
        } catch {
          // Use the response header or the regular backoff below.
        }
        await sleep(Math.max(retryAfter, bodyRetryAfter, 1) * 1000 + 250);
        continue;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(350 * attempt);
  }
  throw lastError;
}

async function mapConcurrent(items, concurrency, task) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await task(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function readMarkerIds() {
  const files = (await fs.readdir(MARKER_DATA_DIR)).filter((name) => name.endsWith(".json"));
  const markerIds = new Set();
  for (const file of files) {
    const rows = JSON.parse(await fs.readFile(path.join(MARKER_DATA_DIR, file), "utf8"));
    for (const row of rows) {
      const markerId = Array.isArray(row) ? row[0] : row?.id;
      if (markerId !== undefined && markerId !== null) markerIds.add(String(markerId));
    }
  }
  return [...markerIds].sort();
}

async function readState(sourceHash) {
  try {
    const state = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    if (state.sourceHash === sourceHash) return state;
  } catch {
    // Start a fresh sync.
  }
  return { sourceHash, scanCursor: 0, images: [], importedKeys: [] };
}

async function writeState(state) {
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function pickBestImages(images) {
  const bestByMarker = new Map();
  for (const image of images) {
    const current = bestByMarker.get(image.markerId);
    const score = Number(image.upvotes ?? image.upvoteCount ?? 0);
    const currentScore = current ? Number(current.upvotes ?? current.upvoteCount ?? 0) : -1;
    const createdAt = Date.parse(image.createdAt);
    const currentCreatedAt = current ? Date.parse(current.createdAt) : Number.POSITIVE_INFINITY;
    if (!current || score > currentScore || (score === currentScore && createdAt < currentCreatedAt)) {
      bestByMarker.set(image.markerId, image);
    }
  }
  return [...bestByMarker.values()];
}

function getObjectKey(imageUrl) {
  return decodeURIComponent(new URL(imageUrl).pathname.replace(/^\/+/, ""));
}

function getLocalImagePath(objectKey) {
  const extension = path.extname(objectKey) || ".bin";
  return path.join(IMAGE_DIR, `${sha256(objectKey)}${extension}`);
}

async function scanRemoteImages(markerIds, state) {
  for (let cursor = state.scanCursor; cursor < markerIds.length; cursor += BATCH_SIZE) {
    const ids = markerIds.slice(cursor, cursor + BATCH_SIZE);
    const url = new URL(REMOTE_API);
    url.searchParams.set("markerIds", ids.join(","));
    url.searchParams.set("limit", "6");
    url.searchParams.set("scope", "prod");
    url.searchParams.set("publicOnly", "1");
    const response = await fetchWithRetry(url);
    const payload = await response.json();
    state.images.push(...(payload.items ?? []));
    state.scanCursor = Math.min(cursor + BATCH_SIZE, markerIds.length);
    await writeState(state);
    if (cursor % (BATCH_SIZE * 20) === 0) {
      console.log(`[demo-sync] scanned ${state.scanCursor}/${markerIds.length} marker ids`);
    }
  }
}

async function downloadImages(images) {
  let downloaded = 0;
  await mapConcurrent(images, DOWNLOAD_CONCURRENCY, async (image) => {
    const objectKey = getObjectKey(image.url);
    const localPath = getLocalImagePath(objectKey);
    try {
      const stat = await fs.stat(localPath);
      if (stat.size > 0) return;
    } catch {
      // Download below.
    }
    const response = await fetchWithRetry(image.url);
    await fs.writeFile(localPath, Buffer.from(await response.arrayBuffer()));
    downloaded += 1;
    if (downloaded % 50 === 0) console.log(`[demo-sync] downloaded ${downloaded} new images`);
  });
}

async function importR2(images, state) {
  const importedKeys = new Set(state.importedKeys);
  const pending = images.filter((image) => !importedKeys.has(getObjectKey(image.url)));
  for (let cursor = 0; cursor < pending.length; cursor += IMPORT_CONCURRENCY) {
    const batch = pending.slice(cursor, cursor + IMPORT_CONCURRENCY);
    await Promise.all(batch.map(async (image) => {
      const objectKey = getObjectKey(image.url);
      await fetchWithRetry(`http://127.0.0.1:8787/__demo/r2?key=${encodeURIComponent(objectKey)}`, {
        method: "PUT",
        headers: { "content-type": "image/webp", "x-demo-local-sync": "1" },
        body: await fs.readFile(getLocalImagePath(objectKey))
      });
      importedKeys.add(objectKey);
    }));
    state.importedKeys = [...importedKeys];
    await writeState(state);
    console.log(`[demo-sync] imported ${Math.min(cursor + batch.length, pending.length)}/${pending.length} images into local R2`);
  }
}

async function importDatabase(images) {
  const userStatement = `INSERT INTO users (uid, email, password_hash, email_verified, role, avt, nickname, uid_number, uid_suffix, nickname_customized) VALUES (${sql(DEMO_USER_ID)}, 'demo-r2-sync@local.invalid', '!', 'true', 'n', 0, 'R2 Demo', 999999, 'DEMO', 1) ON CONFLICT(uid) DO NOTHING;`;
  for (let cursor = 0; cursor < images.length; cursor += 200) {
    const statements = ["PRAGMA foreign_keys = ON;", "BEGIN TRANSACTION;"];
    if (cursor === 0) statements.push(userStatement);
    for (const image of images.slice(cursor, cursor + 200)) {
      const id = `demo_r2_${image.id}`;
      const objectKey = getObjectKey(image.url);
      const createdAt = image.createdAt || new Date().toISOString();
      statements.push(
        `INSERT INTO ugc_submissions (id, kind, poi_id, poi_hash, poi_type, snapshot_id, user_id, content, file_path, status, mime_type, size_bytes, created_at, updated_at) VALUES (${sql(id)}, 'image', ${sql(image.markerId)}, ${sql(image.markerId)}, 'demo', ${sql(id)}, ${sql(DEMO_USER_ID)}, ${image.content == null ? "NULL" : sql(image.content)}, ${sql(objectKey)}, 'active', 'image/webp', ${Number(image.localSize ?? 0)}, ${sql(createdAt)}, ${sql(createdAt)}) ON CONFLICT(id) DO UPDATE SET poi_id=excluded.poi_id, content=excluded.content, file_path=excluded.file_path, status='active', mime_type=excluded.mime_type, size_bytes=excluded.size_bytes, updated_at=excluded.updated_at;`
      );
    }
    statements.push("COMMIT;");
    await fs.writeFile(SQL_FILE, `${statements.join("\n")}\n`);
    await execFileAsync("pnpm", [
      "exec", "wrangler", "d1", "execute", "DB", "--local", "--env", "local", "--file", SQL_FILE
    ], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
    console.log(`[demo-sync] imported ${Math.min(cursor + 200, images.length)}/${images.length} records into local D1`);
  }
}

async function clearLocalKv(images) {
  const keys = images.flatMap((image) => ["default", "test", "prod"].map(
    (namespace) => `ugc:marker-images:v2:${namespace}:${sha256(image.markerId)}`
  ));
  await fs.writeFile(KV_DELETE_FILE, `${JSON.stringify(keys)}\n`);
  await execFileAsync("pnpm", [
    "exec", "wrangler", "kv", "bulk", "delete", KV_DELETE_FILE,
    "--binding", "OEM_KV", "--local", "--env", "local", "--force"
  ], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
}

async function main() {
  await fs.mkdir(IMAGE_DIR, { recursive: true });
  const markerIds = await readMarkerIds();
  const sourceHash = sha256(markerIds.join("\n"));
  const state = await readState(sourceHash);
  await scanRemoteImages(markerIds, state);
  const images = pickBestImages(state.images);
  console.log(`[demo-sync] selected ${images.length} hover images from ${state.images.length} public images`);
  await downloadImages(images);
  for (const image of images) {
    image.localSize = (await fs.stat(getLocalImagePath(getObjectKey(image.url)))).size;
  }
  await importR2(images, state);
  await importDatabase(images);
  await clearLocalKv(images);
  const totalBytes = images.reduce((sum, image) => sum + image.localSize, 0);
  console.log(`[demo-sync] complete: ${images.length} images, ${(totalBytes / 1048576).toFixed(1)} MiB`);
}

await main();
