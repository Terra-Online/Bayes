// Better Auth's D1 introspector reads only schema metadata here. Never cache
// business statements, sessions, prepared statements, or pending database I/O.
export type SchemaQueryResult = D1Result<Record<string, unknown>>;
export type SchemaQueryResults = ReadonlyMap<string, SchemaQueryResult>;

// Cache only the SQLite introspection queries used by Better Auth/Kysely:
// - SELECT ... FROM sqlite_master/sqlite_schema: table definitions.
// - SELECT * FROM pragma_table_info(?): columns of the bound table.
// - PRAGMA table_info(...), index_list(...), index_info(...): columns and indexes.
// Whitespace is normalized before matching; SQL plus bound parameters identifies
// each result (for example, the same column query for two different tables).
// Reject semicolons, JOIN and UNION to keep compound queries out of the cache.
// This is a narrow allowlist, not a SQL parser; other queries go directly to D1.
function schemaQueryCacheKey(sql: string, parameters: unknown[]): string | undefined {
  const normalizedSql = sql.trim().replace(/\s+/g, " ");
  const isSchemaQuery =
    /^select\s+[^;]+\s+from\s+["`]?sqlite_(?:master|schema)["`]?(?:\s|$)/i.test(normalizedSql) ||
    /^select \* from pragma_table_info\(\?\)$/i.test(normalizedSql) ||
    /^pragma (?:table_info|index_list|index_info)\s*\([^;]+\)$/i.test(normalizedSql);
  if (!isSchemaQuery || /;|\bjoin\b|\bunion\b/i.test(normalizedSql)) {
    return undefined;
  }
  return JSON.stringify([normalizedSql, parameters]);
}

function copySchemaResult(result: SchemaQueryResult): SchemaQueryResult {
  const copy = structuredClone(result);
  return { ...copy, meta: { ...copy.meta, duration: 0, rows_read: 0, rows_written: 0 } };
}

export function wrapDatabaseWithSchemaCache(
  database: D1Database,
  cachedResults?: SchemaQueryResults,
  getTableNames?: () => ReadonlySet<string>,
) {
  const uncachedResults = new Map<string, SchemaQueryResult>();
  const statementSources = new WeakMap<
    D1PreparedStatement,
    { sourceStatement: D1PreparedStatement; cacheKey?: string }
  >();
  function prepare(sql: string, parameters: unknown[] = []): D1PreparedStatement {
    const cacheKey = schemaQueryCacheKey(sql, parameters);
    const sourceStatement = parameters.length
      ? database.prepare(sql).bind(...parameters)
      : database.prepare(sql);
    if (!cacheKey) {
      return sourceStatement;
    }
    async function all(): Promise<SchemaQueryResult> {
      const cachedResult = cacheKey ? cachedResults?.get(cacheKey) : undefined;
      if (cachedResult) {
        return copySchemaResult(cachedResult);
      }
      const result = await sourceStatement.all<Record<string, unknown>>();
      // Kysely enumerates every table before reading columns and indexes. Auth
      // validates only its configured models, including models added by plugins.
      if (getTableNames && /^select "name", "type" from "sqlite_master" where /i.test(sql.trim())) {
        const allowedTableNames = getTableNames();
        result.results = result.results.filter((row) => allowedTableNames.has(String(row.name)));
      }
      if (cacheKey && result.success) {
        uncachedResults.set(cacheKey, copySchemaResult(result));
      }
      return result;
    }
    const wrappedStatement = new Proxy(sourceStatement, {
      get(target, property) {
        if (property === "bind") {
          return (...bindings: unknown[]) => prepare(sql, bindings);
        }
        if (cacheKey && property === "all") {
          return all;
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    statementSources.set(wrappedStatement, { sourceStatement, cacheKey });
    return wrappedStatement;
  }
  const patchedDatabase = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return prepare;
      }
      if (property === "batch") {
        return async (batch: D1PreparedStatement[]) => {
          const sources = batch.map((statement) => statementSources.get(statement));
          if (
            batch.length &&
            sources.every((source) => source?.cacheKey && cachedResults?.has(source.cacheKey))
          ) {
            return sources.map((source) =>
              copySchemaResult(cachedResults!.get(source!.cacheKey!)!),
            );
          }
          const results = await database.batch<Record<string, unknown>>(
            batch.map((statement, index) => sources[index]?.sourceStatement ?? statement),
          );
          sources.forEach((source, index) => {
            if (source?.cacheKey && results[index]?.success) {
              uncachedResults.set(source.cacheKey, copySchemaResult(results[index]!));
            }
          });
          return results;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    db: patchedDatabase,
    getUncachedResults: (): SchemaQueryResults => {
      return uncachedResults;
    },
  };
}
