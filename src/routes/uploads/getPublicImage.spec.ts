import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import { runWithAuthRequest } from "@/lib/auth/betterAuth";
import type { PublicSubmissionImage } from "@/repositories/submission/types";
import { createMockBindings, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import {
  insertAuthenticatedUser,
  insertAuthUser,
  insertSession,
  type SessionHeaders,
} from "@/test/fixtures/auth";
import { seedImageReadScenario } from "@/test/fixtures/imageReadScenario";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, exports: {} }));
vi.mock("@cloudflare/containers", () => ({ getRandom: vi.fn() }));

let database: TestDatabase;
let mocks: MockBindings;
let app: ReturnType<typeof createApp>;
let viewerHeaders: SessionHeaders;
let otherViewerHeaders: SessionHeaders;

beforeEach(() => {
  database = createTestDatabase();
  seedImageReadScenario(database.sqlite);
  insertAuthUser(database.sqlite, { id: "viewer" });
  viewerHeaders = insertSession(database.sqlite, { userId: "viewer" }).headers;
  otherViewerHeaders = insertAuthenticatedUser(database.sqlite, { uid: "other-viewer" }).headers;
  mocks = createMockBindings({ DB: database.db });
  mocks.bindings.UGC_ASSET_BASE_URL = "https://assets.example.com";
  mocks.bindings.UGC_UPLOAD_TEST_PREFIX = "";
  app = createApp();
});

afterEach(() => database.close());

function request(path: string, headers?: HeadersInit) {
  // Use a public hostname so production asset URLs are not rewritten for localhost.
  return runWithAuthRequest(() =>
    app.request(`https://api.example.com/uploads/v1${path}`, { headers }, mocks.bindings),
  );
}

/** Every successful image read must satisfy the same public HTTP contract. */
async function requestImage(path: string, headers?: HeadersInit): Promise<PublicSubmissionImage> {
  const response = await request(path, headers);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const payload = (await response.json()) as { item: PublicSubmissionImage };
  return payload.item;
}

describe("public image details through HTTP", () => {
  it("returns a visible image with counts and public author data", async () => {
    const image = await requestImage("/images/photo?markerId=42");

    expect(image).toMatchObject({
      id: "photo",
      markerId: "42",
      url: "https://assets.example.com/images/photo.webp",
      content: "Caption",
      author: { nickname: "Author", publicUid: "123CD" },
      status: "active",
      upvoteCount: 2,
      flagCount: 1,
    });
    expect(image.upvoted).toBeUndefined();
    expect(image.flagged).toBeUndefined();
  });

  it.each(["active", "flagged", "remove_request"])("allows public status %s", async (status) => {
    database.sqlite.prepare("UPDATE ugc_submissions SET status = ? WHERE id = 'photo'").run(status);

    const image = await requestImage("/images/photo?markerId=42");
    expect(image).toMatchObject({ id: "photo", status });
  });

  it.each(["pending_openai", "pending_audit", "stale"])(
    "hides non-public status %s",
    async (status) => {
      database.sqlite
        .prepare("UPDATE ugc_submissions SET status = ? WHERE id = 'photo'")
        .run(status);

      const response = await request("/images/photo?markerId=42");
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    },
  );

  it("does not return a comment through the image endpoint", async () => {
    database.sqlite.prepare("UPDATE ugc_submissions SET kind = 'comment' WHERE id = 'photo'").run();

    const response = await request("/images/photo?markerId=42");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it.each([
    { name: "missing ID", id: "missing", markerId: "42" },
    { name: "SQL-like ID", id: "photo' OR 1=1 --", markerId: "42" },
    { name: "wrong marker", id: "photo", markerId: "99" },
    { name: "SQL-like marker", id: "photo", markerId: "42' OR 1=1 --" },
  ])("requires an exact match for $name", async (scenario) => {
    const response = await request(
      `/images/${encodeURIComponent(scenario.id)}?markerId=${encodeURIComponent(scenario.markerId)}`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND", message: "Image not found." });
  });

  it("applies production and test path scopes", async () => {
    expect(await requestImage("/images/photo?markerId=42&scope=prod")).toMatchObject({
      id: "photo",
    });
    expect((await request("/images/test-photo?markerId=42&scope=prod")).status).toBe(404);
    expect(await requestImage("/images/test-photo?markerId=42&scope=test")).toMatchObject({
      id: "test-photo",
    });
    expect((await request("/images/photo?markerId=42&scope=test")).status).toBe(404);
  });

  it("keeps query-only credentials anonymous while header credentials return viewer reactions", async () => {
    const token = viewerHeaders.authorization.slice(7);
    const path = `/images/photo?markerId=42&access_token=${encodeURIComponent(token)}`;
    const anonymous = await requestImage(path);
    expect(anonymous.upvoted).toBeUndefined();
    expect(anonymous.flagged).toBeUndefined();

    const authenticated = await requestImage(path, viewerHeaders);
    expect(authenticated).toMatchObject({ upvoted: true, flagged: true });
  });

  it("returns reactions for the authenticated viewer without exposing another viewer's state", async () => {
    const viewerImage = await requestImage("/images/photo?markerId=42&scope=prod", viewerHeaders);
    expect(viewerImage).toMatchObject({
      upvoted: true,
      flagged: true,
      upvoteCount: 2,
      flagCount: 1,
    });

    const otherViewerImage = await requestImage("/images/photo?markerId=42", otherViewerHeaders);
    expect(otherViewerImage).toMatchObject({ upvoted: false, flagged: false });
  });
});
