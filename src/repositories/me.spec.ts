import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import { seedImageReadScenario } from "@/test/fixtures/imageReadScenario";
import { importCurrentSubmissions } from "@/test/fixtures/ugcSnapshots";

import { getContributionImage, listContributionRecords } from "./me";

let database: TestDatabase;
beforeEach(() => {
  database = createTestDatabase();
  seedImageReadScenario(database.sqlite);
  importCurrentSubmissions(database);
});
afterEach(() => {
  vi.restoreAllMocks();
  database.close();
});

const list = () =>
  listContributionRecords(database.db, {
    uid: "author",
    limit: 20,
  });
it("loads a bounded page in one query and freshly selects previews with owner checks", async () => {
  const queryCount = database.queries.length;
  await list();
  // Review evidence must be fetched with the page rather than once per contribution.
  expect(database.queries).toHaveLength(queryCount + 1);
  expect(await getContributionImage(database.db, "author", "photo")).toMatchObject({
    file_path: "images/photo.webp",
  });
  expect(await getContributionImage(database.db, "other", "photo")).toBeNull();
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
