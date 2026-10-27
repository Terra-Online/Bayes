import type { SchemaQueryResults } from "./schemaCacheWrapper";

type CacheSlot = { schemaQueryResults?: SchemaQueryResults };
const cachePerDB = new WeakMap<D1Database, CacheSlot>();

export function getOrInit(database: D1Database): CacheSlot {
  let slot = cachePerDB.get(database);
  if (!slot) {
    slot = {};
    cachePerDB.set(database, slot);
  }
  return slot;
}
