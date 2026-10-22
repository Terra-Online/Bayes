import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import type { AppEnv } from "@/types/app";

import { createRoutes } from "./createRoutes";

let objects: Map<string, { bytes: Uint8Array; contentType: string }>;

beforeEach(() => {
  objects = new Map();
});

function request(url: string, backendUrl: string, init: RequestInit) {
  const app = new Hono<AppEnv>();
  app.route("/__demo", createRoutes());
  return app.request(url, { ...init, method: "PUT" }, {
    BETTER_AUTH_URL: backendUrl,
    UGC_BUCKET: {
      put: async (key: string, body: ArrayBuffer, options: R2PutOptions) => {
        objects.set(key, {
          bytes: new Uint8Array(body),
          contentType: (options.httpMetadata as R2HTTPMetadata).contentType!,
        });
      },
    },
  } as unknown as AppEnv["Bindings"]);
}

describe("local demo object upload HTTP", () => {
  it.each([
    {
      name: "a production backend",
      backendUrl: "https://api.opendfieldmap.org",
      url: "http://localhost:8787/__demo/r2?key=photo.webp",
      flag: "1",
    },
    {
      name: "a remote request",
      backendUrl: "http://localhost:8787",
      url: "https://api.opendfieldmap.org/__demo/r2?key=photo.webp",
      flag: "1",
    },
    {
      name: "a local request without explicit sync opt-in",
      backendUrl: "http://localhost:8787",
      url: "http://localhost:8787/__demo/r2?key=photo.webp",
      flag: "",
    },
  ])(
    "hides the upload endpoint for $name without storing data",
    async ({ backendUrl, url, flag }) => {
      const response = await request(url, backendUrl, {
        headers: { "x-demo-local-sync": flag },
        body: "Demo file",
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
      expect(objects.size).toBe(0);
    },
  );

  it.each([
    ["image/webp", "image/webp"],
    [undefined, "application/octet-stream"],
  ])("stores local sync bytes with supplied content type %s", async (suppliedType, storedType) => {
    const response = await request(
      "http://127.0.0.1:8787/__demo/r2?key=%20demo%2Fphoto.webp%20",
      "http://localhost:8787",
      {
        headers: {
          "x-demo-local-sync": "1",
          ...(suppliedType ? { "content-type": suppliedType } : {}),
        },
        body: new Uint8Array([82, 73, 70, 70]),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, key: "demo/photo.webp" });
    expect(objects.get("demo/photo.webp")).toEqual({
      bytes: new Uint8Array([82, 73, 70, 70]),
      contentType: storedType,
    });
  });

  it("rejects an empty object key without writing a file", async () => {
    const response = await request(
      "http://localhost:8787/__demo/r2?key=%20%20",
      "http://localhost:8787",
      {
        headers: { "x-demo-local-sync": "1" },
        body: "Demo file",
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "missing_key" });
    expect(objects.size).toBe(0);
  });
});
