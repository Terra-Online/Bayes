import { betterAuth } from "better-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import type { Bindings } from "@/types/app";

import { createAuth, runWithAuthRequest } from "./createAuth";

describe("completed authentication context reuse", () => {
  const databases: TestDatabase[] = [];
  function environment(): Bindings {
    const database = createTestDatabase();
    databases.push(database);
    return {
      ...createMockBindings({ DB: database.db }).bindings,
      // These paths fail before delivery; unexpected mail must fail at the binding.
      EMAIL_PROVIDER_MODE: "cloudflare_only",
      BETTER_AUTH_URL: "https://api.opendfieldmap.org",
      BETTER_AUTH_SECRET: "test-context-secret-at-least-32-characters",
      GOOGLE_CLIENT_ID: "test-google",
      GOOGLE_CLIENT_SECRET: "test-secret",
      GITHUB_CLIENT_ID: "test-github",
      GITHUB_CLIENT_SECRET: "test-secret",
      DISCORD_CLIENT_ID: "test-discord",
      DISCORD_CLIENT_SECRET: "test-secret",
    };
  }
  // Empty credentials exercise the public readiness gate without a session lookup.
  async function readInitializedContext(auth: ReturnType<typeof createAuth>) {
    await auth.api.getSession({ headers: new Headers() });
    return auth.$context;
  }
  function schemaReads(database = databases[0]!) {
    return database.queries.filter(({ sql }) => /sqlite_master/.test(sql)).length;
  }
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
    vi.restoreAllMocks();
  });

  it("checks real D1 metadata once and keeps database connections separate across requests", async () => {
    const env = environment();
    databases[0]!.sqlite.exec(
      "CREATE TABLE local_rowid_fixture (id INTEGER PRIMARY KEY AUTOINCREMENT)",
    );
    const first = createAuth(env);
    const context = await readInitializedContext(first);
    expect(schemaReads()).toBe(1);
    const schemaStatements = databases[0]!.queries.length;
    expect(
      databases[0]!.queries.some(({ sql }) => /index_list.*local_rowid_fixture/.test(sql)),
    ).toBe(false);
    expect(databases[0]!.queries.filter(({ sql }) => /pragma_table_info/.test(sql))).toHaveLength(
      4,
    );
    const second = createAuth({ ...env });
    expect(await readInitializedContext(second)).not.toBe(context);
    await second.api.getSession({ headers: new Headers() });
    expect(schemaReads()).toBe(1);
    expect(databases[0]!.queries).toHaveLength(schemaStatements);
    expect(second.options.advanced?.database?.validateSchema).not.toBe(false);
  });

  it("reuses database metadata across unrelated binding and secret changes without reusing auth configuration", async () => {
    const env = environment();
    await readInitializedContext(createAuth(env));
    const updated = {
      ...env,
      BETTER_AUTH_SECRET: "rotated-secret-at-least-32-characters",
      OEM_KV: {} as KVNamespace,
    };
    const next = createAuth(updated);
    await readInitializedContext(next);
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
    await readInitializedContext(optimized);
    const scoped = database.queries.filter(({ sql }) => /pragma_table_info/.test(sql)).length;
    database.queries.length = 0;
    const baseline = betterAuth({ ...optimized.options, database: env.DB });
    await (await baseline.$context).checkSchema?.();
    const unscoped = database.queries.filter(({ sql }) => /pragma_table_info/.test(sql)).length;
    expect(scoped).toBe(4);
    expect(unscoped).toBeGreaterThanOrEqual(scoped + 21);
  });

  it("exposes the original context but blocks auth operations when an auth table is missing", async () => {
    const env = environment();
    databases[0]!.sqlite.exec("DROP TABLE auth_verifications");
    const auth = createAuth(env);
    await expect(auth.$context).resolves.toBeDefined();
    await expect(auth.api.getSession({ headers: new Headers() })).rejects.toThrow();
    await expect(
      auth.handler(new Request("https://api.opendfieldmap.org/auth/v1/get-session")),
    ).rejects.toThrow();
    expect(schemaReads()).toBe(1);
  });

  it("does not share pending initialization across concurrent cold callers", async () => {
    const env = environment();
    const first = createAuth(env);
    const second = createAuth(env);
    const contexts = await Promise.all([
      readInitializedContext(first),
      readInitializedContext(second),
    ]);
    expect(contexts[0]).not.toBe(contexts[1]);
    expect(schemaReads()).toBe(2);
    expect(await readInitializedContext(createAuth(env))).not.toBe(contexts[0]);
    expect(schemaReads()).toBe(2);
  });

  it("isolates database bindings and configuration changes, including in-place changes", async () => {
    const env = environment();
    const first = await readInitializedContext(createAuth(env));
    const other = environment();
    expect(await readInitializedContext(createAuth(other))).not.toBe(first);
    for (const change of [
      { SESSION_TTL_SECONDS: "3600" },
      { BETTER_AUTH_URL: "https://api.opendfieldmap.cn" },
      { BETTER_AUTH_SECRET: "rotated-test-secret-at-least-32-characters" },
      { GOOGLE_CLIENT_ID: "rotated-client" },
      { TRUSTED_ORIGINS: "https://opendfieldmap.cn" },
      { EMAIL_TEMPLATE_DEFAULT_LOCALE: "en" },
    ]) {
      const updated = { ...env, ...change };
      const context = await readInitializedContext(createAuth(updated));
      expect(context).not.toBe(first);
      const queries = schemaReads();
      expect(await readInitializedContext(createAuth(updated))).not.toBe(context);
      expect(schemaReads()).toBe(queries);
    }
    env.BETTER_AUTH_SECRET = "mutated-test-secret-at-least-32-characters";
    expect(await readInitializedContext(createAuth(env))).not.toBe(first);
  });

  it("keeps configuration request-local when schema checks overlap", async () => {
    const env = environment();
    const old = createAuth(env);
    const updated = { ...env, SESSION_TTL_SECONDS: "3600" };
    const replacement = createAuth(updated);
    const [, context] = await Promise.all([
      readInitializedContext(old),
      readInitializedContext(replacement),
    ]);
    expect(await readInitializedContext(createAuth(updated))).not.toBe(context);
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
    await expect(readInitializedContext(createAuth(env))).rejects.toThrow(
      "D1 temporarily unavailable",
    );
    database.hooks.beforeQuery = undefined;
    database.sqlite.exec("ALTER TABLE auth_users RENAME COLUMN email TO invalid_email");
    await expect(readInitializedContext(createAuth(env))).rejects.toThrow();
    database.sqlite.exec("ALTER TABLE auth_users RENAME COLUMN invalid_email TO email");
    const context = await readInitializedContext(createAuth(env));
    expect(await readInitializedContext(createAuth(env))).not.toBe(context);
    expect(schemaReads()).toBe(2);
  });

  it("keeps concurrent handler error callbacks private with warm schema metadata", async () => {
    const env = environment();
    await readInitializedContext(createAuth(env));
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
      expect(await readInitializedContext(b)).toBe(await readInitializedContext(a));
      return readInitializedContext(a);
    });
    const second = await runWithAuthRequest(() => readInitializedContext(createAuth(env)));
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
      await expect(readInitializedContext(createAuth(env))).rejects.toThrow("retryable-init");
      databases[0]!.hooks.beforeQuery = undefined;
      const auth = createAuth(env);
      await expect(auth.api.getSession({ headers: new Headers() })).resolves.toBeNull();
      expect(schemaReads()).toBe(1);
    });
  });
});
