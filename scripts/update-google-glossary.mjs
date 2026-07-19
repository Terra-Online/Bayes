#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const DEFAULT_PROJECT_ID = "open-endfield-map";
const DEFAULT_LOCATION = "us-central1";
const DEFAULT_GLOSSARY_ID = "oem-glossary";
const DEFAULT_BUCKET = "oem-glossary";
const DEFAULT_LOCAL_FILE = "scripts/glossary.csv";
const DEFAULT_GCS_URI = `gs://${DEFAULT_BUCKET}/glossary.csv`;
const DEFAULT_LANGUAGE_CODES = [
  "zh-CN",
  "zh-TW",
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "it",
  "es",
  "pt",
  "ru",
  "th",
  "vi",
  "id"
];

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(stderr || `${command} ${args.join(" ")} failed.`);
  }
  return result.stdout?.trim() ?? "";
}

function curlJson({ method, url, token, projectId, body }) {
  const args = [
    "-sS",
    "--max-time",
    "60",
    "-X",
    method,
    "-H",
    `Authorization: Bearer ${token}`,
    "-H",
    `x-goog-user-project: ${projectId}`,
    "-H",
    "Content-Type: application/json"
  ];
  const proxy = process.env.GOOGLE_API_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) {
    args.push("-x", proxy);
  }
  if (body) {
    args.push("--data", JSON.stringify(body));
  }
  args.push("-w", "\n%{http_code}", url);

  const output = run("curl", args, { capture: true });
  const newline = output.lastIndexOf("\n");
  const text = newline >= 0 ? output.slice(0, newline) : "";
  const status = Number(newline >= 0 ? output.slice(newline + 1) : output);
  const payload = text ? JSON.parse(text) : {};
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new Error(`${method} ${url} failed (${status}). ${JSON.stringify(payload, null, 2)}`);
  }
  return payload;
}

async function waitForOperation({ operationName, token, projectId }) {
  const encodedName = operationName.split("/").map(encodeURIComponent).join("/");
  const url = `https://translation.googleapis.com/v3/${encodedName}`;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const operation = curlJson({ method: "GET", url, token, projectId });
    if (operation.done) {
      if (operation.error) {
        throw new Error(`Glossary operation failed. ${JSON.stringify(operation.error, null, 2)}`);
      }
      return operation;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Glossary operation did not finish in time: ${operationName}`);
}

async function main() {
  const projectId = readArg("project", process.env.GOOGLE_TRANSLATE_PROJECT_ID || DEFAULT_PROJECT_ID);
  const location = readArg("location", process.env.GOOGLE_TRANSLATE_LOCATION || DEFAULT_LOCATION);
  const glossaryId = readArg("glossary", DEFAULT_GLOSSARY_ID);
  const localFile = readArg("file", DEFAULT_LOCAL_FILE);
  const gcsUri = readArg("gcs-uri", DEFAULT_GCS_URI);
  const languageCodes = readArg("languages", process.env.GOOGLE_TRANSLATE_GLOSSARY_LANGUAGES || DEFAULT_LANGUAGE_CODES.join(","))
    .split(",")
    .map((language) => language.trim())
    .filter(Boolean);
  const parent = `projects/${projectId}/locations/${location}`;
  const glossaryName = `${parent}/glossaries/${glossaryId}`;
  const glossaryUrl = `https://translation.googleapis.com/v3/${glossaryName}`;
  const createUrl = `https://translation.googleapis.com/v3/${parent}/glossaries`;

  if (existsSync(localFile)) {
    console.log(`[glossary] Uploading ${localFile} -> ${gcsUri}`);
    run("gcloud", ["storage", "cp", localFile, gcsUri]);
  } else {
    console.log(`[glossary] Local file not found, reloading existing GCS object: ${gcsUri}`);
  }

  const token = run("gcloud", ["auth", "print-access-token"], { capture: true });
  const glossaryBody = {
    name: glossaryName,
    languageCodesSet: {
      languageCodes
    },
    inputConfig: {
      gcsSource: {
        inputUri: gcsUri
      }
    }
  };

  let existing = null;
  try {
    existing = curlJson({ method: "GET", url: glossaryUrl, token, projectId });
  } catch (error) {
    if (!String(error instanceof Error ? error.message : error).includes("failed (404)")) {
      throw error;
    }
  }

  if (!existing) {
    console.log(`[glossary] Creating ${glossaryName}`);
    const operation = curlJson({
      method: "POST",
      url: createUrl,
      token,
      projectId,
      body: glossaryBody
    });
    await waitForOperation({ operationName: operation.name, token, projectId });
  } else {
    console.log(`[glossary] Updating ${glossaryName}`);
    const operation = curlJson({
      method: "PATCH",
      url: `${glossaryUrl}?updateMask=input_config`,
      token,
      projectId,
      body: {
        name: glossaryName,
        inputConfig: glossaryBody.inputConfig
      }
    });
    await waitForOperation({ operationName: operation.name, token, projectId });
  }

  const updated = curlJson({ method: "GET", url: glossaryUrl, token, projectId });
  console.log(`[glossary] Ready: ${updated.name}`);
  console.log(`[glossary] Entry count: ${updated.entryCount ?? "unknown"}`);
  console.log("[glossary] Bump GOOGLE_TRANSLATE_GLOSSARY_VERSION before deploying to cut a new translation cache version.");
}

main().catch((error) => {
  console.error(`[glossary] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
