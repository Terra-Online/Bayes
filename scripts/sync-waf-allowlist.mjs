#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const sourcePath = resolve(repositoryRoot, "src/app.ts");
const outputPath = resolve(repositoryRoot, "config/waf-allowlist.json");
const phase = "http_request_firewall_custom";
const ruleDescription = "oem-backend: deny unknown API paths";
const apply = process.argv.includes("--apply");
const check = process.argv.includes("--check");
const envFileArgumentIndex = process.argv.indexOf("--vars-file");
const envFilePath = envFileArgumentIndex >= 0 ? process.argv[envFileArgumentIndex + 1] : null;

function fail(message) {
  console.error(`[waf] ${message}`);
  process.exitCode = 1;
}

async function loadEnvFile(path) {
  if (!path) return;
  let content;
  try {
    content = await readFile(resolve(repositoryRoot, path), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value.replace(/\\n/g, "\n");
  }
}

function literalText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function isIgnored(source, node) {
  const nearby = source.slice(Math.max(0, node.getFullStart() - 180), node.getStart());
  return nearby.includes("@waf-ignore");
}

function normalizePath(raw, sourceName) {
  if (!raw.startsWith("/")) throw new Error(`${sourceName}: path must start with /: ${raw}`);
  if (raw.includes("?") || raw.includes("#") || raw.includes("..")) {
    throw new Error(`${sourceName}: path contains query, fragment, or traversal: ${raw}`);
  }
  if (raw === "/*") throw new Error(`${sourceName}: root wildcard is not allowed`);
  return raw.replace(/\/$/, "") || "/";
}

function extractPrefixes(source) {
  const file = ts.createSourceFile("src/app.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const prefixes = new Set();
  const directPaths = [];

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const method = node.expression.name.text;
      if (ts.isIdentifier(receiver) && receiver.text === "app") {
        if (method === "use" || method === "onError") {
          ts.forEachChild(node, visit);
          return;
        }
        const raw = node.arguments[0] ? literalText(node.arguments[0]) : null;
        if (raw && !isIgnored(source, node)) {
          const normalized = normalizePath(raw, `app.${method}`);
          if (method === "route") prefixes.add(normalized);
          else directPaths.push({ method, path: normalized });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  for (const item of directPaths) {
    if (item.path === "/") prefixes.add("/");
    else throw new Error(`app.${item.method}(${JSON.stringify(item.path)}) needs // @waf-ignore or a route mount`);
  }

  return [...prefixes].sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
}

function pathExpression(path) {
  if (path === "/") return 'http.request.uri.path eq "/"';
  return `(http.request.uri.path eq "${path}" or starts_with(http.request.uri.path, "${path}/"))`;
}

function buildExpression(host, paths) {
  const allowed = paths.map(pathExpression).join(" or ");
  return `(http.host eq "${host}" and not (${allowed}))`;
}

async function cloudflare(path, options = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required for --apply");
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json();
  if (!response.ok || payload.success !== true) {
    throw new Error(`Cloudflare API ${response.status}: ${JSON.stringify(payload.errors ?? payload)}`);
  }
  return payload.result;
}

async function applyRule(host, expression) {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  if (!zoneId) throw new Error("CLOUDFLARE_ZONE_ID is required for --apply");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID");
  }
  try {
    await cloudflare(accountId ? `/accounts/${accountId}/tokens/verify` : "/user/tokens/verify");
  } catch {
    throw new Error(
      accountId
        ? "Cloudflare account API token verification failed; check CLOUDFLARE_ACCOUNT_ID and create an active API Token for that account"
        : "Cloudflare API token verification failed; create an active API Token (not an API key) and check its value"
    );
  }
  const rulesets = await cloudflare(`/zones/${zoneId}/rulesets?phase=${phase}`);
  const listedRuleset = rulesets.find(
    (item) =>
      item.phase === phase
      && item.kind === "zone"
      && (item.name === "oem-backend-custom-waf" || item.description === "Managed by scripts/sync-waf-allowlist.mjs")
  ) ?? rulesets.find((item) => item.phase === phase && item.kind === "zone");
  const rule = { action: "block", description: ruleDescription, enabled: true, expression };

  if (!listedRuleset) {
    await cloudflare(`/zones/${zoneId}/rulesets`, {
      method: "POST",
      body: {
        name: "oem-backend-custom-waf",
        description: "Managed by scripts/sync-waf-allowlist.mjs",
        kind: "zone",
        phase,
        rules: [rule]
      }
    });
    return;
  }

  // The phase list endpoint returns ruleset summaries without `rules`; fetch the
  // detail document before deciding whether this managed rule already exists.
  const ruleset = await cloudflare(`/zones/${zoneId}/rulesets/${listedRuleset.id}`);
  const existingRules = (ruleset.rules ?? []).filter((item) => item.description === ruleDescription);
  if (existingRules.length === 0) {
    await cloudflare(`/zones/${zoneId}/rulesets/${ruleset.id}/rules`, { method: "POST", body: rule });
    return;
  }

  await cloudflare(`/zones/${zoneId}/rulesets/${ruleset.id}/rules/${existingRules[0].id}`, {
    method: "PATCH",
    body: rule
  });

  for (const duplicate of existingRules.slice(1)) {
    await cloudflare(`/zones/${zoneId}/rulesets/${ruleset.id}/rules/${duplicate.id}`, {
      method: "DELETE"
    });
    console.log(`[waf] removed duplicate rule ${duplicate.id}`);
  }
}

try {
  await loadEnvFile(envFilePath);
  const source = await readFile(sourcePath, "utf8");
  const paths = extractPrefixes(source);
  if (paths.length === 0) throw new Error("no WAF prefixes found in src/app.ts");

  const host = process.env.WAF_HOST || "api.opendfieldmap.org";
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error(`invalid WAF_HOST: ${host}`);
  const output = { host, paths };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (check) {
    let existing;
    try {
      existing = await readFile(outputPath, "utf8");
    } catch {
      throw new Error(`${outputPath} is missing; run pnpm run waf:sync`);
    }
    if (existing !== serialized) {
      throw new Error(`${outputPath} is out of date; run pnpm run waf:sync`);
    }
    console.log(`[waf] ${outputPath} matches src/app.ts`);
    process.exit(0);
  }

  await writeFile(outputPath, serialized, "utf8");
  const expression = buildExpression(host, paths);

  console.log(`[waf] generated ${paths.length} prefixes in ${outputPath}`);
  console.log(`[waf] expression: ${expression}`);
  if (apply) {
    await applyRule(host, expression);
    console.log(`[waf] applied rule: ${ruleDescription}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
