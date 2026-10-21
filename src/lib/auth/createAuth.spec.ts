import { betterAuth } from "better-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthDatabase } from "@/test/authDatabase";
import type { Bindings } from "@/types/app";

import { createAuth, runWithAuthRequest } from "./createAuth";

vi.mock("@/lib/email/sender", () => ({ sendEmail: vi.fn() }));

describe("completed authentication context reuse", () => {
  const databases: ReturnType<typeof createAuthDatabase>[] = [];
  function environment(): Bindings {
    const database = createAuthDatabase();
    databases.push(database);
    return {
      DB: database.db,
      BETTER_AUTH_URL: "https://api.opendfieldmap.org",
      BETTER_AUTH_SECRET: "test-context-secret-at-least-32-characters",
      GOOGLE_CLIENT_ID: "test-google",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GITHUB_CLIENT_ID: "test-github",
      GITHUB_CLIENT_SECRET: "test-secret",
      DISCORD_CLIENT_ID: "test-discord",
      DISCORD_CLIENT_SECRET: "test-secret",
    } as Bindings;
  }
  function schemaReads(database = databases[0]!) {
    return database.queries.filter((sql) => /sqlite_master/.test(sql)).length;
  }
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    databases.splice(0).forEach((database) => database.sqlite.close());
    vi.restoreAllMocks();
  });

  it("checks real D1 metadata once and keeps database connections separate across requests", async () => {
    const env = environment();
    databases[0]!.sqlite.exec(
      "CREATE TABLE local_rowid_fixture (id INTEGER PRIMARY KEY AUTOINCREMENT)",
    );
    const first = createAuth(env);
    const context = await first.$context;
    expect(schemaReads()).toBe(1);
    const schemaStatements = databases[0]!.queries.length;
    expect(databases[0]!.queries.some((sql) => /index_list.*local_rowid_fixture/.test(sql))).toBe(
      false,
    );
    expect(databases[0]!.queries.filter((sql) => /pragma_table_info/.test(sql))).toHaveLength(4);
    const second = createAuth({ ...env });
    expect(await second.$context).not.toBe(context);
    await second.api.getSession({ headers: new Headers() });
    expect(schemaReads()).toBe(1);
    expect(databases[0]!.queries).toHaveLength(schemaStatements);
    expect(second.options.advanced?.database?.validateSchema).not.toBe(false);
  });

  it("reuses database metadata across unrelated binding and secret changes without reusing auth configuration", async () => {
    const env = environment();
    await createAuth(env).$context;
    const updated = {
      ...env,
      BETTER_AUTH_SECRET: "rotated-secret-at-least-32-characters",
      OEM_KV: {} as KVNamespace,
    };
    const next = createAuth(updated);
    await next.$context;
    expect(next.options.secret).toBe(updated.BETTER_AUTH_SECRET);
    expect(schemaReads()).toBe(1);
  });

  it("checks the same auth schema while avoiding enumeration of 21 unrelated tables", async () => {
    const env = environment();
    const database = databases[0]!;
    for (let index = 0; index < 21; index++) {
      database.sqlite.exec(`CREATE TABLE business_${index} (id TEXT PRIMARY KEY, payload TEXT)`);
    }
    const optimized = createAuth(env);
    await optimized.$context;
    const scoped = database.queries.filter((sql) => /pragma_table_info/.test(sql)).length;
    database.queries.length = 0;
    const baseline = betterAuth({ ...optimized.options, database: env.DB });
    await (await baseline.$context).checkSchema?.();
    const unscoped = database.queries.filter((sql) => /pragma_table_info/.test(sql)).length;
    expect({ scoped, unscoped }).toEqual({ scoped: 4, unscoped: 25 });
  });

  it("still rejects a missing auth table instead of treating the filtered catalog as complete", async () => {
    const env = environment();
    databases[0]!.sqlite.exec("DROP TABLE auth_verifications");
    await expect(createAuth(env).$context).rejects.toThrow();
    expect(schemaReads()).toBe(1);
  });

  it("does not share pending initialization across concurrent cold callers", async () => {
    const env = environment();
    const first = createAuth(env);
    const second = createAuth(env);
    const contexts = await Promise.all([first.$context, second.$context]);
    expect(contexts[0]).not.toBe(contexts[1]);
    expect(schemaReads()).toBe(2);
    expect(await createAuth(env).$context).not.toBe(contexts[0]);
    expect(schemaReads()).toBe(2);
  });

  it("isolates database bindings and configuration changes, including in-place changes", async () => {
    const env = environment();
    const first = await createAuth(env).$context;
    const other = environment();
    expect(await createAuth(other).$context).not.toBe(first);
    for (const change of [
      { SESSION_TTL_SECONDS: "3600" },
      { BETTER_AUTH_URL: "https://api.opendfieldmap.cn" },
      { BETTER_AUTH_SECRET: "rotated-test-secret-at-least-32-characters" },
      { GOOGLE_CLIENT_ID: "rotated-client" },
      { TRUSTED_ORIGINS: "https://opendfieldmap.cn" },
      { EMAIL_TEMPLATE_DEFAULT_LOCALE: "en" },
    ]) {
      const updated = { ...env, ...change };
      const context = await createAuth(updated).$context;
      expect(context).not.toBe(first);
      const queries = schemaReads();
      expect(await createAuth(updated).$context).not.toBe(context);
      expect(schemaReads()).toBe(queries);
    }
    env.BETTER_AUTH_SECRET = "mutated-test-secret-at-least-32-characters";
    expect(await createAuth(env).$context).not.toBe(first);
  });

  it("keeps configuration request-local when schema checks overlap", async () => {
    const env = environment();
    const old = createAuth(env);
    const updated = { ...env, SESSION_TTL_SECONDS: "3600" };
    const replacement = createAuth(updated);
    const [, context] = await Promise.all([old.$context, replacement.$context]);
    expect(await createAuth(updated).$context).not.toBe(context);
    expect(createAuth(updated).options.session?.expiresIn).toBe(3600);
    expect(schemaReads()).toBe(2);
  });

  it("retries failed initialization and rejects schema mismatches without caching success", async () => {
    const env = environment();
    const database = databases[0]!;
    database.hooks.beforeQuery = (sql) => {
      if (/sqlite_master|pragma/i.test(sql)) {
        throw new Error("D1 temporarily unavailable");
      }
    };
    await expect(createAuth(env).$context).rejects.toThrow("D1 temporarily unavailable");
    database.hooks.beforeQuery = undefined;
    database.sqlite.exec("ALTER TABLE auth_users RENAME COLUMN email TO invalid_email");
    await expect(createAuth(env).$context).rejects.toThrow();
    database.sqlite.exec("ALTER TABLE auth_users RENAME COLUMN invalid_email TO email");
    const context = await createAuth(env).$context;
    expect(await createAuth(env).$context).not.toBe(context);
    expect(schemaReads()).toBe(2);
  });

  it("keeps concurrent handler error callbacks private with warm schema metadata", async () => {
    const env = environment();
    await createAuth(env).$context;
    const errorsA: unknown[] = [];
    const errorsB: unknown[] = [];
    databases[0]!.hooks.beforeQuery = (sql, values) => {
      if (/^insert into "auth_verifications"/i.test(sql)) {
        const marker = values.some((value) => String(value).includes("first@example.test"))
          ? "FIRST"
          : "SECOND";
        throw new Error(`D1 failure ${marker}`);
      }
    };
    async function send(email: string, errors: unknown[]) {
      return createAuth(env, { onError: (error) => errors.push(error) }).handler(
        new Request("https://api.opendfieldmap.org/auth/v1/email-otp/send-verification-otp", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://opendfieldmap.org" },
          body: JSON.stringify({ email, type: "sign-in" }),
        }),
      );
    }
    const responses = await runWithAuthRequest(() =>
      Promise.all([send("first@example.test", errorsA), send("second@example.test", errorsB)]),
    );
    expect(responses.map((response) => response.status)).toEqual([500, 500]);
    expect(errorsA.map(String).join(" ")).toContain("FIRST");
    expect(errorsA.map(String).join(" ")).not.toContain("SECOND");
    expect(errorsB.map(String).join(" ")).toContain("SECOND");
    expect(errorsB.map(String).join(" ")).not.toContain("FIRST");
    await createAuth(env).api.getSession({ headers: new Headers() });
    expect(schemaReads()).toBe(1);
  });

  it("reuses a context and pending initialization only inside the owning request", async () => {
    const env = environment();
    const first = await runWithAuthRequest(async () => {
      const a = createAuth(env);
      const b = createAuth(env);
      expect(b).toBe(a);
      expect(await b.$context).toBe(await a.$context);
      return a.$context;
    });
    const second = await runWithAuthRequest(() => createAuth(env).$context);
    expect(second).not.toBe(first);
    expect(schemaReads()).toBe(1);
  });

  it("discards a failed initialization from the current request so a retry can succeed", async () => {
    const env = environment();
    await runWithAuthRequest(async () => {
      databases[0]!.hooks.beforeQuery = (sql) => {
        if (/sqlite_master|pragma/i.test(sql)) {
          throw new Error("retryable-init");
        }
      };
      await expect(createAuth(env).$context).rejects.toThrow("retryable-init");
      databases[0]!.hooks.beforeQuery = undefined;
      const auth = createAuth(env);
      await expect(auth.api.getSession({ headers: new Headers() })).resolves.toBeNull();
      expect(schemaReads()).toBe(1);
    });
  });
});
