// Local functional regression fixture only. Never referenced by wrangler.toml.
import { AsyncLocalStorage } from "node:async_hooks";

import { Hono } from "hono";

import { createAuth, runWithAuthRequest } from "@/lib/auth/betterAuth";
import { resolveAuthIdentity } from "@/lib/auth/identity";
import { onAppError } from "@/middleware/error-handler";
import { createRoutes as createEmailAuthRoutes } from "@/routes/auth/emailRoutes";
import { createRoutes as createSessionAuthRoutes } from "@/routes/auth/sessionRoutes";
import type { AppEnv, Bindings } from "@/types/app";

type TestEnv = Bindings & { DB_SECOND: D1Database; TEST_GATE: Fetcher };
type Invocation = { sql: string[]; block?: boolean; blockSchema?: boolean; gate: Fetcher };
const invocation = new AsyncLocalStorage<Invocation>();
const databases = new WeakMap<D1Database, D1Database>();
// Negative control: the former middleware's global pending-request pattern.
// Its failure propagation must remain observable to prove the isolation test.
const legacyPending = new Map<string, ReturnType<typeof resolveAuthIdentity>>();
const unsafeSingletons = new WeakMap<D1Database, ReturnType<typeof createAuth>>();
async function singletonAuth(env: Bindings) {
  let auth = unsafeSingletons.get(env.DB);
  if (!auth) {
    auth = createAuth(env);
    await auth.api.getSession({ headers: new Headers() });
    unsafeSingletons.set(env.DB, auth);
  }
  return auth;
}
async function legacyIdentity(env: Bindings, headers: Headers) {
  const key = headers.get("authorization")!;
  const existing = legacyPending.get(key);
  if (existing) {
    return existing;
  }
  const pending = resolveAuthIdentity(env, headers);
  legacyPending.set(key, pending);
  try {
    return await pending;
  } finally {
    if (legacyPending.get(key) === pending) {
      legacyPending.delete(key);
    }
  }
}

function observe(database: D1Database): D1Database {
  let observed = databases.get(database);
  if (observed) {
    return observed;
  }
  const originals = new WeakMap<D1PreparedStatement, { raw: D1PreparedStatement; sql: string }>();
  function statement(raw: D1PreparedStatement, sql: string): D1PreparedStatement {
    const wrapped = new Proxy(raw, {
      get(target, key) {
        if (key === "bind") {
          return (...values: unknown[]) => statement(target.bind(...values), sql);
        }
        const value = Reflect.get(target, key);
        if (typeof value !== "function") {
          return value;
        }
        return async (...args: unknown[]) => {
          const current = invocation.getStore();
          current?.sql.push(sql);
          if (current?.blockSchema && /sqlite_master/.test(sql)) {
            current.blockSchema = false;
            await current.gate.fetch("https://local-gate/schema");
          }
          if (current?.block && /from "auth_sessions"/i.test(sql)) {
            current.block = false;
            await current.gate.fetch("https://local-gate/blocked");
            throw new Error("LOCAL_OWNER_CANCELED");
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
    originals.set(wrapped, { raw, sql });
    return wrapped;
  }
  observed = {
    prepare: (sql: string) => statement(database.prepare(sql), sql),
    batch: (statements: D1PreparedStatement[]) => {
      invocation
        .getStore()
        ?.sql.push(
          ...statements.map((item) => originals.get(item)?.sql ?? "<native D1 batch statement>"),
        );
      return database.batch(statements.map((item) => originals.get(item)?.raw ?? item));
    },
    exec: (sql: string) => database.exec(sql),
  } as D1Database;
  databases.set(database, observed);
  return observed;
}

const app = new Hono<AppEnv<{ requestId: string }>>();
app.onError(onAppError);
app.route("/auth/v1", createEmailAuthRoutes());
app.route("/auth/v1", createSessionAuthRoutes());

export default {
  async fetch(request: Request, raw: TestEnv, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const env = { ...raw, DB: observe(url.searchParams.has("second") ? raw.DB_SECOND : raw.DB) };
    const current: Invocation = {
      sql: [],
      block: request.headers.has("x-test-block"),
      blockSchema: request.headers.has("x-test-block-schema"),
      gate: raw.TEST_GATE,
    };
    return runWithAuthRequest(() =>
      invocation.run(current, async () => {
        let response: Response;
        try {
          if (url.pathname === "/init") {
            await createAuth(env).api.getSession({ headers: new Headers() });
            response = Response.json({ initialized: true });
          } else if (url.pathname === "/singleton-init") {
            await singletonAuth(env);
            response = Response.json({ initialized: true });
          } else if (url.pathname === "/singleton-identity") {
            const session = await (
              await singletonAuth(env)
            ).api.getSession({ headers: request.headers, query: { disableRefresh: true } });
            response = Response.json({ uid: session?.user.id });
          } else if (url.pathname === "/identity" || url.pathname === "/legacy-identity") {
            response = Response.json(
              await (url.pathname === "/legacy-identity" ? legacyIdentity : resolveAuthIdentity)(
                env,
                request.headers,
              ),
            );
          } else {
            response = await app.fetch(request, env, context);
          }
        } catch (error) {
          response = Response.json({ error: String(error) }, { status: 500 });
        }
        response.headers.set(
          "x-test-schema-columns",
          String(current.sql.filter((sql) => /pragma_table_info/.test(sql)).length),
        );
        response.headers.set(
          "x-test-schema-lists",
          String(current.sql.filter((sql) => /sqlite_master/.test(sql)).length),
        );
        response.headers.set("x-test-db-statements", String(current.sql.length));
        response.headers.set(
          "x-test-session-reads",
          String(current.sql.filter((sql) => /from "auth_sessions"/i.test(sql)).length),
        );
        return response;
      }),
    );
  },
};
