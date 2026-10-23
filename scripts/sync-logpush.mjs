#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const lifecycleId = "oem-archive-retention";

export function buildArchivePlan(config) {
  if (
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket) ||
    !/^[a-zA-Z0-9/_-]+$/.test(config.prefix) ||
    config.prefix.startsWith("/") ||
    config.prefix.endsWith("/") ||
    !config.name ||
    !config.scriptName ||
    config.dataset !== "workers_trace_events" ||
    config.retentionDays !== 180 ||
    config.outputOptions?.sample_rate !== 1
  ) {
    throw new Error(
      "Invalid archive config: require a bucket, relative prefix, Workers dataset, 180 days, and no sampling",
    );
  }
  return {
    job: {
      name: config.name,
      dataset: config.dataset,
      enabled: true,
      filter: JSON.stringify({
        where: { key: "ScriptName", operator: "eq", value: config.scriptName },
      }),
      output_options: config.outputOptions,
    },
    destination: `r2://${config.bucket}/${config.prefix}/{DATE}`,
    lifecycle: {
      id: lifecycleId,
      enabled: true,
      conditions: { prefix: `${config.prefix}/` },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: config.retentionDays * 86400 } },
    },
  };
}

export function findArchiveJob(jobs, plan) {
  const matches = jobs.filter(
    (job) =>
      job.name === plan.job.name ||
      (job.dataset === plan.job.dataset &&
        job.destination_conf?.split("?")[0] === plan.destination),
  );
  if (matches.length > 1) {
    throw new Error("Multiple archive jobs match; resolve duplicates before applying");
  }
  const job = matches[0];
  if (
    job &&
    (job.dataset !== plan.job.dataset || job.destination_conf?.split("?")[0] !== plan.destination)
  ) {
    throw new Error("Archive job name is already used by a different dataset or destination");
  }
  return job;
}

export function mergeLifecycle(existing, rule) {
  // PUT replaces all rules, so preserve rules owned by other tooling.
  return { rules: [...existing.filter((item) => item.id !== rule.id), rule] };
}

function requireEnv(env, key) {
  if (!env[key]) {
    throw new Error(`${key} is required; see .logpush.vars.example`);
  }
  return env[key];
}

export async function syncArchive({ config, env, apply = false, request = fetch }) {
  const plan = buildArchivePlan(config);
  const accountId = requireEnv(env, "CLOUDFLARE_ACCOUNT_ID");
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hex ID");
  }
  const token = requireEnv(env, "CLOUDFLARE_API_TOKEN");
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const api = async (path, method = "GET", body) => {
    const response = await request(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json();
    if (!response.ok || payload.success !== true) {
      // API errors can echo destination_conf, including its storage credentials.
      const codes = payload.errors?.map((error) => error.code).join(",") ?? "unknown";
      throw new Error(
        `Cloudflare ${method} ${path}: HTTP ${response.status}, codes ${codes}. Check account permissions and destination credentials.`,
      );
    }
    return payload.result;
  };

  const jobs = await api("/logpush/jobs");
  const existing = findArchiveJob(jobs, plan);
  const bucketPath = `/r2/buckets/${config.bucket}`;
  // Never create a bucket implicitly. Provision the dedicated bucket separately.
  await api(bucketPath);
  const managed = await api(`${bucketPath}/domains/managed`);
  const custom = await api(`${bucketPath}/domains/custom`);
  if (managed.enabled || custom.domains.some((domain) => domain.enabled)) {
    throw new Error("Archive bucket has public access enabled; use a private bucket");
  }
  const lifecycle = await api(`${bucketPath}/lifecycle`);
  if (!apply) {
    return {
      job: existing
        ? {
            id: existing.id,
            enabled: existing.enabled,
            lastComplete: existing.last_complete,
            lastError: existing.last_error,
            hasError: Boolean(existing.error_message),
            filter: existing.filter,
            outputOptions: existing.output_options,
          }
        : null,
      lifecycle: lifecycle.rules,
      private: true,
    };
  }

  // Validate all secrets and dataset fields before the first remote mutation.
  const accessKey = requireEnv(env, "R2_ACCESS_KEY_ID");
  const secret = requireEnv(env, "R2_SECRET_ACCESS_KEY");
  const fields = await api(`/logpush/datasets/${config.dataset}/fields`);
  const missing = config.outputOptions.field_names.filter((field) => !(field in fields));
  if (missing.length) {
    throw new Error(`Dataset fields unavailable: ${missing.join(", ")}`);
  }
  const credentials = new URLSearchParams({
    "account-id": accountId,
    "access-key-id": accessKey,
    "secret-access-key": secret,
  });
  const destination_conf = `${plan.destination}?${credentials}`;
  const validated = await api("/logpush/validate/destination", "POST", { destination_conf });
  if (validated.valid !== true) {
    throw new Error("Logpush destination validation failed; no job or lifecycle was changed");
  }
  await api(`${bucketPath}/lifecycle`, "PUT", mergeLifecycle(lifecycle.rules, plan.lifecycle));
  const job = await api(
    existing ? `/logpush/jobs/${existing.id}` : "/logpush/jobs",
    existing ? "PUT" : "POST",
    { ...plan.job, destination_conf },
  );
  return {
    id: job.id,
    enabled: job.enabled,
    destination: plan.destination,
    retentionDays: config.retentionDays,
  };
}

async function main(args) {
  const allowed = new Set(["--plan", "--status", "--apply", "--vars-file"]);
  let varsPath = ".logpush.vars";
  let mode = "--plan";
  let explicitMode = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!allowed.has(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (arg === "--vars-file") {
      varsPath = args[++index];
      if (!varsPath || varsPath.startsWith("--")) {
        throw new Error("--vars-file needs a path");
      }
    } else {
      if (explicitMode) {
        throw new Error("Choose exactly one of --plan, --status, --apply");
      }
      mode = arg;
      explicitMode = true;
    }
  }
  const config = JSON.parse(await readFile(resolve(root, "config/logpush.json"), "utf8"));
  if (mode === "--plan") {
    console.log(JSON.stringify(buildArchivePlan(config), null, 2));
    return;
  }
  const fileEnv = parseEnv(await readFile(resolve(root, varsPath), "utf8"));
  const result = await syncArchive({
    config,
    env: { ...fileEnv, ...process.env },
    apply: mode === "--apply",
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    // Do not print fetch causes or request bodies containing credentials.
    console.error(`[logpush] ${error.message}`);
    process.exitCode = 1;
  });
}
