import { Hono } from "hono";
import { vi } from "vitest";

import { onAppError } from "@/middleware/error-handler";
import { createRoutes as createAuthRoutes } from "@/routes/auth/createRoutes";
import { createRoutes as createBindingRoutes } from "@/routes/binding/createRoutes";
import { createRoutes as createMeRoutes } from "@/routes/me/createRoutes";
import { runWithAuthRequest } from "@/services/auth/betterAuth";
import { createMockBindings, type MockBindings } from "@/test/bindings";
import { createTestDatabase, type TestDatabase } from "@/test/database/createTestDatabase";
import type { AppEnv } from "@/types/app";

export interface AuthReadGate {
  entered: Promise<void>;
  release(): void;
  fail(error: Error): void;
}

export interface AuthCacheFixture {
  database: TestDatabase;
  external: MockBindings;
  request(path: string, headers: HeadersInit, method?: string): Promise<Response>;
  pauseRead(table: "auth_sessions" | "users"): AuthReadGate;
  close(): Promise<void>;
}

/** Real route/auth/SQL execution, with a one-read completion gate for cache races. */
export function createAuthCacheFixture(): AuthCacheFixture {
  const database = createTestDatabase();
  const external = createMockBindings({ DB: database.db });
  external.bindingRateLimit.limit.mockResolvedValue({ success: true });
  external.publicRateLimit.limit.mockResolvedValue({ success: true });
  const app = new Hono<AppEnv<{ requestId: string }>>();
  app.onError(onAppError);
  app.route("/me/v1", createMeRoutes());
  app.route("/binding/v1", createBindingRoutes());
  app.route("/auth/v1", createAuthRoutes());
  const requests: Promise<Response>[] = [];
  const gates: AuthReadGate[] = [];
  const restorers: (() => void)[] = [];
  return {
    database,
    external,
    request(path, headers, method = "GET") {
      const request = Promise.resolve(
        runWithAuthRequest(() => app.request(path, { headers, method }, external.bindings)),
      );
      requests.push(request);
      return request;
    },
    pauseRead(table) {
      let enter!: () => void;
      let release!: () => void;
      let fail!: (error: Error) => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const pending = new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
      const prepare = database.db.prepare.bind(database.db);
      let claimed = false;
      const spy = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (claimed || !new RegExp(`FROM ["\\x60]?${table}["\\x60]?\\s`, "i").test(sql)) {
          return statement;
        }
        claimed = true;
        const bind = statement.bind.bind(statement);
        statement.bind = (...values) => {
          const bound = bind(...values);
          const first = bound.first.bind(bound);
          const all = bound.all.bind(bound);
          // Capture a real read before suspending its delivery. Revocation can
          // then race with an already-read session without fabricating rows.
          bound.first = async <T>(column?: string): Promise<T | null> => {
            const result = await (column === undefined ? first<T>() : first<T>(column));
            enter();
            await pending;
            return result;
          };
          bound.all = async <T>(): Promise<D1Result<T>> => {
            const result = await all<T>();
            enter();
            await pending;
            return result;
          };
          return bound;
        };
        return statement;
      });
      const gate = { entered, release, fail };
      gates.push(gate);
      restorers.push(() => spy.mockRestore());
      return gate;
    },
    async close() {
      for (const gate of gates) {
        gate.release();
      }
      await Promise.allSettled(requests);
      for (const restore of restorers.reverse()) {
        restore();
      }
      database.close();
    },
  };
}
