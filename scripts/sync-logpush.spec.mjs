import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { buildArchivePlan, findArchiveJob, syncArchive } from "./sync-logpush.mjs";

const config = JSON.parse(
  await readFile(new URL("../config/logpush.json", import.meta.url), "utf8"),
);
const env = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_API_TOKEN: "private-api-token",
  R2_ACCESS_KEY_ID: "access-key",
  R2_SECRET_ACCESS_KEY: "private-secret+with/slash=",
};
const plan = buildArchivePlan(config);

function fixture({
  jobs = [],
  publicBucket = false,
  fail = false,
  validation = true,
  missingField = false,
} = {}) {
  const calls = [];
  const request = async (url, options) => {
    const path = new URL(url).pathname.split(env.CLOUDFLARE_ACCOUNT_ID)[1];
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method: options.method, body });
    let result;
    if (fail) {
      return Response.json(
        {
          success: false,
          errors: [{ code: 10000, message: `private-secret ${env.R2_SECRET_ACCESS_KEY}` }],
        },
        { status: 403 },
      );
    }
    if (path === "/logpush/jobs" && options.method === "GET") {
      result = jobs;
    } else if (path.endsWith("/domains/managed")) {
      result = { enabled: publicBucket };
    } else if (path.endsWith("/domains/custom")) {
      result = { domains: [] };
    } else if (path.endsWith("/lifecycle")) {
      result = {
        rules: [{ id: "unrelated-rule", enabled: true, conditions: { prefix: "other/" } }],
      };
    } else if (path.endsWith("/fields")) {
      result = Object.fromEntries(
        config.outputOptions.field_names
          .filter((field) => !missingField || field !== "CPUTimeMs")
          .map((field) => [field, "description"]),
      );
    } else if (path === "/logpush/validate/destination") {
      result = { valid: validation };
    } else if (path.startsWith("/logpush/jobs") && options.method !== "GET") {
      const job = { ...body, id: 12 };
      jobs.splice(0, jobs.length, job);
      result = job;
    } else if (path === `/r2/buckets/${config.bucket}`) {
      result = { name: config.bucket };
    } else {
      throw new Error(`Unexpected API call ${path}`);
    }
    return Response.json({ success: true, result });
  };
  return { request, calls };
}

describe("archive provisioning", () => {
  it("plans unsampled Workers logs, daily paths, and 180-day prefix-scoped expiry", () => {
    expect(JSON.parse(plan.job.filter)).toEqual({
      where: { key: "ScriptName", operator: "eq", value: "oem-backend" },
    });
    expect(plan.job.output_options.sample_rate).toBe(1);
    expect(plan.destination).toMatch(/\/workers\/oem-backend\/\{DATE\}$/);
    expect(plan.lifecycle.deleteObjectsTransition.condition.maxAge).toBe(180 * 86400);
    expect(() => buildArchivePlan({ ...config, retentionDays: 0 })).toThrow();
  });

  it("checks status using GET only and does not expose destination credentials", async () => {
    const f = fixture({
      jobs: [
        {
          ...plan.job,
          id: 12,
          destination_conf: `${plan.destination}?secret=private-secret`,
          error_message: "private-secret",
        },
      ],
    });
    const status = await syncArchive({ config, env, request: f.request });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    expect(status.job.hasError).toBe(true);
    expect(JSON.stringify(status)).not.toContain("private-secret");
  });

  it("reuses the managed job on repeat applies and preserves unrelated lifecycle rules", async () => {
    const f = fixture();
    const first = await syncArchive({ config, env, apply: true, request: f.request });
    await syncArchive({ config, env, apply: true, request: f.request });
    expect(
      f.calls.filter((call) => call.path === "/logpush/jobs" && call.method === "POST"),
    ).toHaveLength(1);
    expect(f.calls.some((call) => call.path === "/logpush/jobs/12" && call.method === "PUT")).toBe(
      true,
    );
    const expiry = f.calls.find(
      (call) => call.path.endsWith("/lifecycle") && call.method === "PUT",
    );
    expect(expiry.body.rules.map((rule) => rule.id)).toEqual([
      "unrelated-rule",
      "oem-archive-retention",
    ]);
    const create = f.calls.find((call) => call.path === "/logpush/jobs" && call.method === "POST");
    expect(new URL(create.body.destination_conf).searchParams.get("secret-access-key")).toBe(
      env.R2_SECRET_ACCESS_KEY,
    );
    expect(JSON.stringify(first)).not.toContain(env.R2_SECRET_ACCESS_KEY);
    expect(f.calls.some((call) => call.path === "/r2/buckets" && call.method === "POST")).toBe(
      false,
    );
  });

  it.each([
    [{ publicBucket: true }, /public access/],
    [{ missingField: true }, /CPUTimeMs/],
    [{ validation: false }, /validation failed/],
  ])(
    "rejects unsafe or unsupported destinations before changing the job or lifecycle",
    async (options, message) => {
      const f = fixture(options);
      await expect(syncArchive({ config, env, apply: true, request: f.request })).rejects.toThrow(
        message,
      );
      expect(
        f.calls.some(
          (call) =>
            call.method === "PUT" || (call.method === "POST" && call.path === "/logpush/jobs"),
        ),
      ).toBe(false);
    },
  );

  it("does not leak API error bodies", async () => {
    const f = fixture({ fail: true });
    await expect(syncArchive({ config, env, apply: true, request: f.request })).rejects.toThrow(
      "HTTP 403, codes 10000",
    );
    await expect(syncArchive({ config, env, apply: true, request: f.request })).rejects.not.toThrow(
      "private-secret",
    );
  });

  it("refuses ambiguous jobs and name collisions", () => {
    const job = { ...plan.job, destination_conf: plan.destination };
    expect(() => findArchiveJob([job, job], plan)).toThrow(/Multiple/);
    expect(() => findArchiveJob([{ ...job, dataset: "http_requests" }], plan)).toThrow(
      /different dataset/,
    );
  });
});
