import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import sharp from "sharp";

let server;
let diagnostics = "";
const endpoint = "http://127.0.0.1:8080";

before(async () => {
  server = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: { ...process.env, PORT: "8080" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => {
    diagnostics += chunk;
  });
  server.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Image server exited: ${diagnostics}`);
    }
    try {
      const response = await fetch(`${endpoint}/health`);
      if (response.ok) {
        assert.equal(await response.text(), "ok");
        return;
      }
    } catch {
      /* Wait for the local server to bind. */
    }
    await delay(50);
  }
  throw new Error(`Image server did not become healthy: ${diagnostics}`);
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
});

async function prepare(body, mimeType) {
  return fetch(`${endpoint}/prepare`, {
    method: "POST",
    headers: { "content-type": mimeType, "x-source-mime": mimeType },
    body,
  });
}

function image(width = 32, height = 24) {
  return sharp({ create: { width, height, channels: 3, background: { r: 90, g: 130, b: 180 } } });
}

test("uses the security-patched sharp and native dependencies", () => {
  assert.equal(sharp.versions.sharp, "0.35.5");
  for (const [library, minimum] of [
    ["vips", "8.18.3"],
    ["heif", "1.23.2"],
    ["rsvg", "2.63.2"],
  ]) {
    const actual = sharp.versions[library].split(".").map(Number);
    const expected = minimum.split(".").map(Number);
    const firstDifference = actual.findIndex((value, index) => value !== expected[index]);
    assert.ok(
      firstDifference === -1 || actual[firstDifference] > expected[firstDifference],
      `${library}: ${sharp.versions[library]}`,
    );
  }
});

for (const [format, mimeType] of [
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
]) {
  test(`preserves small ${format} images`, async () => {
    const input = await image().toFormat(format).toBuffer();
    const response = await prepare(input, mimeType);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), mimeType);
    assert.equal(response.headers.get("x-converted-to-webp"), "false");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), input);
  });
}

test("converts at the 2160-pixel threshold without enlarging", async () => {
  const response = await prepare(await image(2160, 32).png().toBuffer(), "image/png");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(response.headers.get("x-converted-to-webp"), "true");
  const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  assert.equal(metadata.width, 2160);
  assert.equal(metadata.height, 32);
});

test("keeps images just below the pixel threshold unchanged", async () => {
  const input = await image(2159, 32).png().toBuffer();
  const response = await prepare(input, "image/png");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-converted-to-webp"), "false");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), input);
});

test("converts at the four-megabyte threshold", async () => {
  const input = await image().png().toBuffer();
  const padded = Buffer.concat([input, Buffer.alloc(4 * 1024 * 1024 - input.length)]);
  const response = await prepare(padded, "image/png");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-converted-to-webp"), "true");
  const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  assert.equal(metadata.width, 32);
  assert.equal(metadata.height, 24);
});

test("rotates EXIF-oriented JPEGs before resizing to 2560 pixels", async () => {
  const input = await image(3200, 2200).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const response = await prepare(input, "image/jpeg");
  assert.equal(response.status, 200);
  const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 1760);
  assert.equal(metadata.height, 2560);
});

for (const mimeType of ["image/heic", "image/heif"]) {
  test(`decodes ${mimeType} with the installed system HEVC plugin`, async () => {
    const input = await readFile(new URL("./test-fixtures/tiny.heic", import.meta.url));
    const response = await prepare(input, mimeType);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("x-converted-to-webp"), "true");
    const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 32);
    assert.equal(metadata.height, 24);
  });
}

test("rejects SVG disguised as PNG", async () => {
  const input = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="blue"/></svg>',
  );
  assert.equal((await prepare(input, "image/png")).status, 422);
});

test("rejects GIF disguised as PNG", async () => {
  const input = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  assert.equal((await prepare(input, "image/png")).status, 422);
});

test("rejects TIFF disguised as PNG", async () => {
  assert.equal((await prepare(await image().tiff().toBuffer(), "image/png")).status, 422);
});

test("rejects AVIF disguised as PNG instead of entering sharp's HEIF decoder", async () => {
  assert.equal((await prepare(await image().avif().toBuffer(), "image/png")).status, 422);
});

test("rejects malformed encoded images", async () => {
  assert.equal((await prepare(Buffer.from("not an image"), "image/png")).status, 422);
});

test("handles simultaneous conversions", async () => {
  const input = await image(2160, 32).png().toBuffer();
  const responses = await Promise.all([prepare(input, "image/png"), prepare(input, "image/png")]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(
      (await sharp(Buffer.from(await response.arrayBuffer())).metadata()).format,
      "webp",
    );
  }
});
