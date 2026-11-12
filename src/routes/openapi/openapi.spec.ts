import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import SwaggerParser from "@apidevtools/swagger-parser";
import type { generateSpecs } from "hono-openapi";
import openapiTS, { astToString } from "openapi-typescript";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import { sessionResponseSchema } from "@/routes/schema/auth";
import { notificationReadResponseSchema } from "@/routes/schema/notify";
import { runWithAuthRequest } from "@/services/auth/betterAuth";
import { createMockBindings } from "@/test/bindings";
import { createTestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser } from "@/test/fixtures/auth";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  exports: {
    get PublicReadCache() {
      throw new Error("Unexpected public cache access in OpenAPI tests");
    },
  },
}));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));

describe("OpenAPI delivery and client contract", () => {
  let database: ReturnType<typeof createTestDatabase>;
  beforeEach(() => {
    database = createTestDatabase();
  });
  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
  });

  it("serves a valid, client-generatable specification covering the actual external routes", async () => {
    const app = createApp();
    const { bindings } = createMockBindings({ DB: database.db });
    bindings.BETTER_AUTH_URL = "http://localhost:8787";
    const response = await app.request("/openapi.json", {}, bindings);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const spec = (await response.json()) as Awaited<ReturnType<typeof generateSpecs>>;
    await SwaggerParser.validate(structuredClone(spec));
    const generatedTypes = astToString(await openapiTS(JSON.stringify(spec)));
    const directory = mkdtempSync(join(tmpdir(), "bayes-openapi-"));
    try {
      writeFileSync(join(directory, "generated.ts"), generatedTypes);
      const consumer = join(directory, "consumer.ts");
      writeFileSync(
        consumer,
        `
        import type { paths, components } from "./generated";
        type CommentInput = paths["/uploads/v1/comments"]["post"]["requestBody"]["content"]["application/json"];
        const input: CommentInput = { markerId: "point", poiHash: "hash", poiType: "chest", content: "A comment" };
        // @ts-expect-error The generated contract must require content.
        const missingContent: CommentInput = { markerId: "point", poiHash: "hash", poiType: "chest" };
        function render(node: components["schemas"]["CommentNode"]): string {
          if (node.type === "comment") return node.content;
          // @ts-expect-error A hidden placeholder has no content.
          node.content;
          return node.id;
        }
        type User = paths["/auth/v1/session"]["get"]["responses"][200]["content"]["application/json"]["user"];
        const publicUid: User["uid"] = "42AB";
        type DeleteInput = paths["/moderation/v1/submissions/{id}/delete"]["post"]["requestBody"]["content"]["application/json"];
        const deletion: DeleteInput = { expectedSnapshotId: "A", expectedLifecycleVersion: 2 };
        // @ts-expect-error Deletion must bind the inspected lifecycle version.
        const staleDeletion: DeleteInput = { expectedSnapshotId: "A" };
        type Inspect = paths["/moderation/v1/submissions/{id}"]["get"]["responses"][200]["content"]["application/json"]["item"];
        function inspect(item: Inspect): number { return item.lifecycleVersion + item.frontier.reviewVersion; }
        type RevisionInput = paths["/moderation/v1/submissions/{id}/revisions"]["post"]["requestBody"]["content"]["application/json"];
        const reuse: RevisionInput = { expectedSnapshotId: "B", sourceSnapshotId: "A" };
        // @ts-expect-error Internal revision change objects are not HTTP input.
        const internalRevision: RevisionInput = { expectedSnapshotId: "B", change: { type: "reuse", sourceSnapshotId: "A" } };

      `,
      );
      const program = ts.createProgram([consumer], {
        noEmit: true,
        strict: true,
        types: [],
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      });
      expect(
        ts
          .getPreEmitDiagnostics(program)
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
      ).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    // Compare the real HTTP inventory with the published operations. This catches
    // a new endpoint silently missing from the document, without a second route list.
    const expected = new Set(
      app.routes
        .filter(
          (route) =>
            route.method !== "ALL" &&
            !route.path.startsWith("/__demo") &&
            !["/auth/v1/*", "/doc", "/docs", "/openapi.json"].includes(route.path),
        )
        .map(
          (route) =>
            `${route.method.toLowerCase()} ${route.path.replace(/\/\*$/, "/:path").replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`,
        ),
    );
    const actual = new Set(
      Object.entries(spec.paths ?? {}).flatMap(([path, methods]) =>
        Object.keys(methods ?? {})
          .filter((method) =>
            ["get", "post", "patch", "delete", "put", "options", "head"].includes(method),
          )
          .map((method) => `${method} ${path}`),
      ),
    );
    expect(actual).toEqual(expected);
    const operationIds = Object.values(spec.paths ?? {}).flatMap((path) =>
      Object.values(path ?? {}).flatMap((value) =>
        value && typeof value === "object" && "operationId" in value ? [value.operationId] : [],
      ),
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(Object.keys(spec.paths ?? {}).some((path) => path.startsWith("/__demo"))).toBe(false);
  });

  it("keeps production documentation opt-in and disables production UI requests", async () => {
    const app = createApp();
    const { bindings } = createMockBindings({ DB: database.db });
    bindings.BETTER_AUTH_URL = "https://api.example.test";
    for (const path of ["/doc", "/docs", "/openapi.json"]) {
      expect((await app.request(path, {}, bindings)).status).toBe(404);
    }
    bindings.API_DOCS_ENABLED = "true";
    const alias = await app.request("/doc", {}, bindings);
    expect(alias.status).toBe(307);
    expect(alias.headers.get("location")).toBe("/docs");
    const html = await (await app.request("/docs", {}, bindings)).text();
    expect(html).toMatch(/supportedSubmitMethods:\s*\[\]/);
    const productionSpecResponse = await app.request("/openapi.json", {}, bindings);
    expect(productionSpecResponse.status).toBe(200);
    expect(
      ((await productionSpecResponse.json()) as Awaited<ReturnType<typeof generateSpecs>>)
        .components?.securitySchemes?.sessionCookie,
    ).toMatchObject({ name: "__Secure-oem-chips.session_token" });
    bindings.BETTER_AUTH_URL = "http://127.0.0.1:8787";
    bindings.API_DOCS_ENABLED = "false";
    expect((await app.request("/docs", {}, bindings)).status).toBe(404);
    expect((await app.request("/openapi.json", {}, bindings)).status).toBe(404);
    delete bindings.API_DOCS_ENABLED;
    const localHtml = await (await app.request("/docs", {}, bindings)).text();
    expect(localHtml).toMatch(/supportedSubmitMethods:\s*\["get","post"/);
  });

  it("keeps public UID responses and legacy profile parsing compatible with the documented contract", async () => {
    const identity = insertAuthenticatedUser(database.sqlite, {
      uid: "internal-id",
      uid_number: 42,
      uid_suffix: "AB",
      nickname: "Before",
      avt: 1,
    });
    const { bindings, authRateLimit } = createMockBindings({ DB: database.db });
    authRateLimit.limit.mockResolvedValue({ success: true });
    const app = createApp();
    const session = await runWithAuthRequest(() =>
      app.request("/auth/v1/session", { headers: identity.headers }, bindings),
    );
    expect(session.status).toBe(200);
    const payload = sessionResponseSchema.parse(await session.json());
    expect(payload.user.uid).toBe("42AB");
    const updated = await runWithAuthRequest(() =>
      app.request(
        "/auth/v1/profile",
        {
          method: "PATCH",
          headers: { ...identity.headers, "Content-Type": "application/x-www-form-urlencoded" },
          body: "nickname=After&avt=9",
        },
        bindings,
      ),
    );
    expect(updated.status).toBe(200);
    expect(sessionResponseSchema.parse(await updated.json()).user).toMatchObject({
      uid: "42AB",
      nickname: "After",
      avatar: 9,
    });
    const missingCredentials = await app.request(
      "/auth/v1/profile",
      { method: "PATCH", body: "broken json" },
      bindings,
    );
    expect(missingCredentials.status).toBe(401);
    const invalidJson = await runWithAuthRequest(() =>
      app.request(
        "/auth/v1/profile",
        {
          method: "PATCH",
          headers: { ...identity.headers, "Content-Type": "application/json" },
          body: "broken json",
        },
        bindings,
      ),
    );
    expect(invalidJson.status).toBe(422);
    expect(await invalidJson.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("documents real notification writes without consuming or validating their bodies twice", async () => {
    const identity = insertAuthenticatedUser(database.sqlite, { uid: "reader" });
    const { bindings, authRateLimit } = createMockBindings({ DB: database.db });
    authRateLimit.limit.mockResolvedValue({ success: true });
    const response = await runWithAuthRequest(() =>
      createApp().request(
        "/notify/v1/system/messages/read",
        {
          method: "POST",
          headers: { ...identity.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ ids: ["missing-notification"] }),
        },
        bindings,
      ),
    );
    expect(response.status).toBe(200);
    expect(notificationReadResponseSchema.parse(await response.json())).toEqual({
      ok: true,
      changed: 0,
      unread: { system: 0, community: 0, total: 0 },
    });
  });
});
