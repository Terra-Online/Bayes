import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** Exercise Better Auth's D1 dialect, including native DELETE RETURNING. */
export function createAuthDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "0002_better_auth.sql",
    "0005_auth_verifications_unique_identifier.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const queries: string[] = [];
  const hooks: { beforeQuery?: (sql: string, values: SQLInputValue[]) => void } = {};
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const execute = () => {
      hooks.beforeQuery?.(sql, values);
      queries.push(sql);
      const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, "$p$1"));
      const named = /\?\d+/.test(sql)
        ? Object.fromEntries(values.map((value, index) => [`$p${index + 1}`, value]))
        : undefined;
      if (statement.columns().length > 0) {
        const results = named ? statement.all(named) : statement.all(...values);
        const changed = !/^\s*(?:select|pragma)/i.test(sql);
        return {
          results,
          success: true,
          meta: { changes: changed ? results.length : 0, last_row_id: 0 },
        };
      }
      const result = named ? statement.run(named) : statement.run(...values);
      return {
        results: [],
        success: true,
        meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
      };
    };
    return {
      bind: (...bindings: SQLInputValue[]) => prepare(sql, bindings),
      all: async () => execute(),
      run: async () => execute(),
      first: async (column?: string) => {
        const row = execute().results[0];
        return column ? (row?.[column] ?? null) : (row ?? null);
      },
      raw: async () => execute().results.map((row) => Object.values(row)),
    };
  }
  const db = {
    prepare,
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
    batch: async (statements: Array<ReturnType<typeof prepare>>) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.all());
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { sqlite, db, queries, hooks };
}
