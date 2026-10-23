import { readFile, readdir } from "node:fs/promises";

import { unstable_splitSqlQuery } from "wrangler";

const directory = new URL("../../migrations/", import.meta.url);

/** Execute native D1 SQL using Wrangler's splitter, including complete trigger bodies. */
export async function executeNativeSql(database, source) {
  const results = [];
  for (const statement of unstable_splitSqlQuery(source)) {
    results.push(await database.prepare(statement).run());
  }
  return results;
}

/** Fresh native business fixtures use the real migration chain before scenario seeds. */
export async function migrateNativeDatabase(database) {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    await executeNativeSql(database, await readFile(new URL(file, directory), "utf8"));
  }
}
