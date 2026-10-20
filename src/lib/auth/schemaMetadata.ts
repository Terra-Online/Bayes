// Better Auth's D1 introspector reads only schema metadata here. Never cache
// business statements, sessions, prepared statements, or pending database I/O.
type Metadata = Map<string, D1Result<Record<string, unknown>>>;

function schemaKey(sql: string, values: unknown[]): string | undefined {
  const text = sql.trim().replace(/\s+/g, " ");
  const metadata =
    /^select\s+[^;]+\s+from\s+["`]?sqlite_(?:master|schema)["`]?(?:\s|$)/i.test(text) ||
    /^select \* from pragma_table_info\(\?\)$/i.test(text) ||
    /^pragma (?:table_info|index_list|index_info)\s*\([^;]+\)$/i.test(text);
  if (!metadata || /;|\bjoin\b|\bunion\b/i.test(text)) {
    return undefined;
  }
  return JSON.stringify([text, values]);
}

function completedResult(
  result: D1Result<Record<string, unknown>>,
): D1Result<Record<string, unknown>> {
  const copy = structuredClone(result);
  return { ...copy, meta: { ...copy.meta, duration: 0, rows_read: 0, rows_written: 0 } };
}

export function authSchemaDatabase(
  database: D1Database,
  validated?: ReadonlyMap<string, D1Result<Record<string, unknown>>>,
  tables?: () => ReadonlySet<string>,
) {
  const metadata: Metadata = new Map();
  const statements = new WeakMap<D1PreparedStatement, { raw: D1PreparedStatement; key?: string }>();
  function prepare(sql: string, values: unknown[] = []): D1PreparedStatement {
    const key = schemaKey(sql, values);
    const raw = values.length ? database.prepare(sql).bind(...values) : database.prepare(sql);
    if (!key) {
      return raw;
    }
    async function all(): Promise<D1Result<Record<string, unknown>>> {
      const cached = key ? validated?.get(key) : undefined;
      if (cached) {
        return completedResult(cached);
      }
      const result = await raw.all<Record<string, unknown>>();
      // Kysely enumerates every table before reading columns and indexes. Auth
      // validates only its configured models, including models added by plugins.
      if (tables && /^select "name", "type" from "sqlite_master" where /i.test(sql.trim())) {
        const names = tables();
        result.results = result.results.filter((row) => names.has(String(row.name)));
      }
      if (key && result.success) {
        metadata.set(key, completedResult(result));
      }
      return result;
    }
    const wrapped = new Proxy(raw, {
      get(target, property) {
        if (property === "bind") {
          return (...bindings: unknown[]) => prepare(sql, bindings);
        }
        if (key && property === "all") {
          return all;
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    statements.set(wrapped, { raw, key });
    return wrapped;
  }
  const db = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return prepare;
      }
      if (property === "batch") {
        return async (batch: D1PreparedStatement[]) => {
          const entries = batch.map((statement) => statements.get(statement));
          if (batch.length && entries.every((entry) => entry?.key && validated?.has(entry.key))) {
            return entries.map((entry) => completedResult(validated!.get(entry!.key!)!));
          }
          const results = await database.batch<Record<string, unknown>>(
            batch.map((statement, index) => entries[index]?.raw ?? statement),
          );
          entries.forEach((entry, index) => {
            if (entry?.key && results[index]?.success) {
              metadata.set(entry.key, completedResult(results[index]!));
            }
          });
          return results;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, metadata };
}
