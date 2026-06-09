import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const WEBP_CONVERSION_MIN_BYTES = 4 * 1024 * 1024;
const WEBP_CONVERSION_MIN_EDGE = 2160;
const WEBP_RESIZE_EDGE = 2560;
const WEBP_QUALITY = 80;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const passthroughMimeTypes = new Set(["image/webp", "image/avif"]);
const supportedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif"
]);

function normalizeMime(value) {
  return (value ?? "").split(";")[0].trim().toLowerCase();
}

function isHeifMime(mimeType) {
  return mimeType === "image/heic" || mimeType === "image/heif";
}

function sendText(response, status, text) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  response.end(text);
}

async function decodeHeifToPng(body) {
  const dir = await mkdtemp(path.join(tmpdir(), "oem-heif-"));
  const inputPath = path.join(dir, "source.heic");
  const outputPath = path.join(dir, "decoded.png");

  try {
    await writeFile(inputPath, body);
    await execFileAsync("heif-convert", ["--quality", "100", inputPath, outputPath], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy(new Error("Image body is too large."));
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks, size)));
    request.on("error", reject);
  });
}

async function prepareImage(body, sourceMimeType) {
  if (!supportedMimeTypes.has(sourceMimeType)) {
    throw new Error(`Unsupported image MIME type: ${sourceMimeType}`);
  }

  if (passthroughMimeTypes.has(sourceMimeType)) {
    return {
      body,
      mimeType: sourceMimeType,
      converted: false
    };
  }

  const imageBody = isHeifMime(sourceMimeType) ? await decodeHeifToPng(body) : body;
  const image = sharp(imageBody, {
    failOn: "error",
    limitInputPixels: 64_000_000
  }).rotate();
  const metadata = await image.metadata();
  const longestEdge = Math.max(metadata.width ?? 0, metadata.height ?? 0);
  const shouldConvert = isHeifMime(sourceMimeType)
    || body.byteLength >= WEBP_CONVERSION_MIN_BYTES
    || longestEdge >= WEBP_CONVERSION_MIN_EDGE;

  if (!shouldConvert) {
    return {
      body,
      mimeType: sourceMimeType,
      converted: false
    };
  }

  const transformed = await image
    .resize({
      width: WEBP_RESIZE_EDGE,
      height: WEBP_RESIZE_EDGE,
      fit: "inside",
      withoutEnlargement: true
    })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();

  return {
    body: transformed,
    mimeType: "image/webp",
    converted: true
  };
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    sendText(response, 200, "ok");
    return;
  }

  if (request.method !== "POST" || request.url !== "/prepare") {
    sendText(response, 404, "Not found.");
    return;
  }

  try {
    const sourceMimeType = normalizeMime(request.headers["x-source-mime"] ?? request.headers["content-type"]);
    const body = await readBody(request);
    if (body.byteLength <= 0) {
      sendText(response, 422, "Image body is empty.");
      return;
    }

    const prepared = await prepareImage(body, sourceMimeType);
    response.writeHead(200, {
      "Content-Type": prepared.mimeType,
      "Content-Length": prepared.body.byteLength,
      "X-Converted-To-Webp": prepared.converted ? "true" : "false"
    });
    response.end(prepared.body);
  } catch (error) {
    sendText(response, 422, error instanceof Error ? error.message : "Image could not be processed.");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.warn(`oem_imgTrans listening on ${PORT}`);
});
