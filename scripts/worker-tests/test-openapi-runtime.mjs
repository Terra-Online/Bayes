import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bundleFixture, Miniflare } from "./worker-test-runtime.mjs";

const temporary = await mkdtemp(join(tmpdir(), "bayes-openapi-runtime-"));
try {
  const fixture = await bundleFixture(temporary, "openapiRuntime");
  for (const scenario of [
    { name: "local defaults", origin: "http://127.0.0.1:8787", enabled: true, interactive: true },
    { name: "production defaults", origin: "https://api.example.test", enabled: false },
    {
      name: "production opt-in",
      origin: "https://api.example.test",
      flag: "true",
      enabled: true,
      interactive: false,
    },
    { name: "local opt-out", origin: "http://127.0.0.1:8787", flag: "false", enabled: false },
  ]) {
    await test(`OpenAPI in workerd: ${scenario.name}`, async () => {
      const worker = new Miniflare({
        ...fixture,
        bindings: {
          BETTER_AUTH_URL: scenario.origin,
          ...(scenario.flag ? { API_DOCS_ENABLED: scenario.flag } : {}),
        },
        // Generating the contract must not access a provider or live storage.
        outboundService: () => {
          throw new Error("Unexpected network access while serving documentation");
        },
      });
      try {
        const specResponse = await worker.dispatchFetch(`${scenario.origin}/openapi.json`);
        const uiResponse = await worker.dispatchFetch(`${scenario.origin}/docs`);
        assert.equal(specResponse.status, scenario.enabled ? 200 : 404);
        assert.equal(uiResponse.status, scenario.enabled ? 200 : 404);
        assert.equal(specResponse.headers.get("cache-control"), "private, no-store");
        if (scenario.enabled) {
          const spec = await specResponse.json();
          assert.equal(spec.openapi, "3.1.0");
          assert.ok(spec.paths["/uploads/v1/comments"].post.requestBody);
          assert.ok(spec.paths["/moderation/v1/{id}/status"].patch.security.length);
          assert.equal(
            Object.keys(spec.paths).some((path) => path.startsWith("/__demo")),
            false,
          );
          const html = await uiResponse.text();
          assert.match(
            html,
            scenario.interactive
              ? /supportedSubmitMethods:\s*\["get","post"/
              : /supportedSubmitMethods:\s*\[\]/,
          );
        }
      } finally {
        await worker.dispose();
      }
    });
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
