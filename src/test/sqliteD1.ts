import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type RecordedQuery = { sql: string; values: SQLInputValue[]; changes: number };

class SqliteStatement {
  constructor(
    private readonly database: SqliteD1,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = []
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    if (values.length > 100) throw new Error("D1 parameter limit exceeded");
    return new SqliteStatement(this.database, this.sql, values as SQLInputValue[]) as unknown as D1PreparedStatement;
  }

  execute(): D1Result<Record<string, unknown>> {
    const statement = this.database.sqlite.prepare(this.sql);
    const parameters = Object.fromEntries(this.values.map((value, index) => [String(index + 1), value]));
    const write = /^\s*(UPDATE|INSERT|DELETE)/i.test(this.sql);
    const results = statement.columns().length > 0 ? statement.all(parameters) : [];
    let changes = 0;
    if (statement.columns().length === 0) {
      changes = Number(statement.run(parameters).changes);
    } else if (write) {
      changes = Number(this.database.sqlite.prepare("SELECT changes() AS count").get()?.count);
    }
    this.database.queries.push({ sql: this.sql, values: this.values, changes });
    return { success: true, results, meta: { changes } } as D1Result<Record<string, unknown>>;
  }

  async first<Result>(): Promise<Result | null> {
    return (this.execute().results[0] as Result | undefined) ?? null;
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
  readonly db = this as unknown as D1Database;

  prepare(sql: string): D1PreparedStatement {
    return new SqliteStatement(this, sql) as unknown as D1PreparedStatement;
  }

  async batch<Result>(statements: D1PreparedStatement[]): Promise<D1Result<Result>[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => (statement as unknown as SqliteStatement).execute());
      this.sqlite.exec("COMMIT");
      return results as unknown as D1Result<Result>[];
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  explain(query: RecordedQuery): string {
    const values = Object.fromEntries(query.values.map((value, index) => [String(index + 1), value]));
    return this.sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(values)
      .map((row) => String(row.detail)).join("\n");
  }
}
