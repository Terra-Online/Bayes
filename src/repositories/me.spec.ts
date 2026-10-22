import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { seedImageReadScenario } from "@/test/fixtures/imageReadScenario";

import { getContributionImage, listContributions } from "./me";

let database: TestDatabase;
beforeEach(() => {
  database = createTestDatabase();
  seedImageReadScenario(database.sqlite);
});
afterEach(() => {
  vi.restoreAllMocks();
  database.close();
});

const list = () =>
  listContributions(database.db, {
    uid: "author",
    limit: 20,
    previewBaseUrl: "/me/v1/contributions",
  });
it("reuses list file metadata for previews without bypassing owner checks", async () => {
  await list();
  const prepare = vi.spyOn(database.db, "prepare");
  expect(await getContributionImage(database.db, "author", "photo")).toMatchObject({
    file_path: "images/photo.webp",
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(await getContributionImage(database.db, "other", "photo")).toBeNull();
  expect(prepare).toHaveBeenCalledOnce();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
  await getContributionImage(database.db, "author", "photo");
  expect(prepare).toHaveBeenCalledTimes(2);
});

it("does not share an unfinished preview lookup with another invocation", async () => {
  const prepare = database.db.prepare.bind(database.db);
  let rejectFirst!: (error: Error) => void;
  vi.spyOn(database.db, "prepare")
    .mockImplementationOnce(
      () =>
        ({
          bind() {
            return this;
          },
          first: () =>
            new Promise((_resolve, reject) => {
              rejectFirst = reject;
            }),
        }) as unknown as D1PreparedStatement,
    )
    .mockImplementation(prepare);
  const first = getContributionImage(database.db, "author", "photo");
  const rejected = expect(first).rejects.toThrow("first request failed");
  expect(await getContributionImage(database.db, "author", "photo")).toMatchObject({
    file_path: "images/photo.webp",
  });
  rejectFirst(new Error("first request failed"));
  await rejected;
  expect(await getContributionImage(database.db, "author", "photo")).toMatchObject({
    file_path: "images/photo.webp",
  });
});
