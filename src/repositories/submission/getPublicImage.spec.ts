import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "@/test/database/createTestDatabase";
import { seedImageReadScenario } from "@/test/fixtures/imageReadScenario";

import { getPublicImageById } from "./getPublicImage";

let database: ReturnType<typeof createTestDatabase>;
let sqlite: ReturnType<typeof createTestDatabase>["sqlite"];
let db: D1Database;

beforeEach(() => {
  database = createTestDatabase();
  seedImageReadScenario(database.sqlite);
  sqlite = database.sqlite;
  db = database.db;
});

afterEach(() => database.close());

const imageQuery = {
  id: "photo",
  markerId: "42",
  assetBaseUrl: "https://assets.example.com",
};

describe("getPublicImageById", () => {
  it("returns a visible image with counts and public author data", async () => {
    const image = await getPublicImageById(db, imageQuery);

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
    expect(image?.upvoted).toBeUndefined();
    expect(image?.flagged).toBeUndefined();
  });

  it.each(["active", "flagged", "remove_request"])("allows public status %s", async (status) => {
    sqlite.prepare("UPDATE ugc_submissions SET status = ? WHERE id = 'photo'").run(status);

    await expect(getPublicImageById(db, imageQuery)).resolves.not.toBeNull();
  });

  it.each(["pending_openai", "pending_audit", "stale"])(
    "hides non-public status %s",
    async (status) => {
      sqlite.prepare("UPDATE ugc_submissions SET status = ? WHERE id = 'photo'").run(status);

      await expect(getPublicImageById(db, imageQuery)).resolves.toBeNull();
    },
  );

  it("requires the exact image ID, marker, and image kind", async () => {
    await expect(getPublicImageById(db, { ...imageQuery, id: "missing" })).resolves.toBeNull();
    await expect(
      getPublicImageById(db, { ...imageQuery, id: "photo' OR 1=1 --" }),
    ).resolves.toBeNull();
    await expect(getPublicImageById(db, { ...imageQuery, markerId: "99" })).resolves.toBeNull();
    await expect(
      getPublicImageById(db, { ...imageQuery, markerId: "42' OR 1=1 --" }),
    ).resolves.toBeNull();

    sqlite.prepare("UPDATE ugc_submissions SET kind = 'comment' WHERE id = 'photo'").run();
    await expect(getPublicImageById(db, imageQuery)).resolves.toBeNull();
  });

  it("applies production and test path scopes", async () => {
    await expect(
      getPublicImageById(db, { ...imageQuery, excludePathPrefix: "_test" }),
    ).resolves.toMatchObject({ id: "photo" });
    await expect(
      getPublicImageById(db, {
        ...imageQuery,
        id: "test-photo",
        excludePathPrefix: "_test",
      }),
    ).resolves.toBeNull();
    await expect(
      getPublicImageById(db, {
        ...imageQuery,
        id: "test-photo",
        pathPrefix: "_test",
      }),
    ).resolves.toMatchObject({ id: "test-photo" });
    await expect(
      getPublicImageById(db, {
        ...imageQuery,
        pathPrefix: "_test",
      }),
    ).resolves.toBeNull();
  });

  it("includes viewer reactions only when a viewer is supplied", async () => {
    const viewer = await getPublicImageById(db, { ...imageQuery, viewerUserId: "viewer" });
    expect(viewer).toMatchObject({
      upvoted: true,
      flagged: true,
      upvoteCount: 2,
      flagCount: 1,
    });

    const otherViewer = await getPublicImageById(db, {
      ...imageQuery,
      viewerUserId: "other-viewer",
    });
    expect(otherViewer).toMatchObject({ upvoted: false, flagged: false });
  });
});
