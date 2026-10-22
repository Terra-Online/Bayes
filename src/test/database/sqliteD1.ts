import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type RecordedQuery = { sql: string; values: SQLInputValue[]; changes: number };

class SqliteStatement {
  constructor(
    private readonly database: SqliteD1,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    if (values.length > 100) {
      throw new Error("D1 parameter limit exceeded");
    }
    return new SqliteStatement(
      this.database,
      this.sql,
      values as SQLInputValue[],
    ) as unknown as D1PreparedStatement;
  }

  execute(): D1Result<Record<string, unknown>> {
    this.database.hooks.beforeQuery?.(this.sql, this.values);
    const statement = this.database.sqlite.prepare(this.sql);
    const parameters = /\?\d+/.test(this.sql)
      ? Object.fromEntries(this.values.map((value, index) => [String(index + 1), value]))
      : undefined;
    const write = /^\s*(UPDATE|INSERT|DELETE)/i.test(this.sql);
    let results: Record<string, unknown>[] = [];
    if (statement.columns().length > 0) {
      results = parameters ? statement.all(parameters) : statement.all(...this.values);
    }
    let changes = 0;
    let lastRowId = 0;
    if (statement.columns().length === 0) {
      const result = parameters ? statement.run(parameters) : statement.run(...this.values);
      changes = Number(result.changes);
      lastRowId = Number(result.lastInsertRowid);
    } else if (write) {
      changes = Number(this.database.sqlite.prepare("SELECT changes() AS count").get()?.count);
    }
    this.database.queries.push({ sql: this.sql, values: this.values, changes });
    return { success: true, results, meta: { changes, last_row_id: lastRowId } } as D1Result<
      Record<string, unknown>
    >;
  }

  async first<Result>(column?: string): Promise<Result | null> {
    const row = this.execute().results[0];
    return ((column ? row?.[column] : row) as Result | undefined) ?? null;
  }

  async raw<Result>(): Promise<Result[]> {
    return this.execute().results.map((row) => Object.values(row)) as Result[];
  }

  async all<Result>(): Promise<D1Result<Result>> {
    return this.execute() as unknown as D1Result<Result>;
  }

  async run<Result>(): Promise<D1Result<Result>> {
    return this.execute() as unknown as D1Result<Result>;
  }
}

export class SqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  readonly queries: RecordedQuery[] = [];
  // Expose only the binding API. Better Auth interprets an object with a `db`
  // property as a Kysely configuration instead of a D1 binding.
  readonly db = {
    prepare: (sql: string) => this.prepare(sql),
    batch: <Result>(statements: D1PreparedStatement[]) => this.batch<Result>(statements),
    exec: (sql: string) => this.exec(sql),
  } as unknown as D1Database;
  readonly hooks: { beforeQuery?: (sql: string, values: SQLInputValue[]) => void } = {};

  close(): void {
    this.sqlite.close();
  }

  async exec(sql: string): Promise<D1ExecResult> {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }

  prepare(sql: string): D1PreparedStatement {
    return new SqliteStatement(this, sql) as unknown as D1PreparedStatement;
  }

  async batch<Result>(statements: D1PreparedStatement[]): Promise<D1Result<Result>[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) =>
        (statement as unknown as SqliteStatement).execute(),
      );
      this.sqlite.exec("COMMIT");
      return results as unknown as D1Result<Result>[];
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  explain(query: RecordedQuery): string {
    const statement = this.sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`);
    const rows = /\?\d+/.test(query.sql)
      ? statement.all(
          Object.fromEntries(query.values.map((value, index) => [String(index + 1), value])),
        )
      : statement.all(...query.values);
    return rows.map((row) => String(row.detail)).join("\n");
  }
}
