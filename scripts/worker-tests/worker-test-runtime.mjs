import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(require.resolve("wrangler/package.json"));
export const { Miniflare } = runtimeRequire("miniflare");
const { build } = runtimeRequire("esbuild");
export const root = resolve(import.meta.dirname, "../..");
export const compatibility = {
  compatibilityDate: "2026-07-22",
  compatibilityFlags: ["nodejs_compat"],
};

export async function bundleFixture(temporary, name) {
  const output = join(temporary, `${name}.mjs`);
  await build({
    entryPoints: [join(root, `src/test/${name}.worker.ts`)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["node:*", "cloudflare:*"],
  });
  return {
    modules: [{ type: "ESModule", path: output }],
    modulesRoot: temporary,
    ...compatibility,
  };
}

export function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
export async function within(promise, timeout = 8000) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(timeout, null, { signal: controller.signal }).then(() => {
        throw new Error("Local runtime regression did not settle");
      }),
    ]);
  } finally {
    controller.abort();
  }
}
