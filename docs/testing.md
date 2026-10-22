# Testing for refactoring

Tests protect observable business behavior while allowing implementation to move
between routes, services, and repositories. Choose the smallest meaningful
interface that exercises the rule being protected.

## Business regression tests

Most business tests should send requests through `app.request()` with production
routes, authentication middleware, and error handling. Run internal application
modules normally against an independent, migrated SQLite database. Assert the
HTTP result and relevant persisted outcomes, including rejected writes, ownership,
idempotency, and failure recovery.

Replace remote providers and runtime facilities at their seams. Email and game
providers may use controlled HTTP responses; object storage and queues may use
local adapters. Keep business rules and repositories real. Use explicit synthetic
policy and lookup data when deployment configuration is incidental to the scenario.

Assert external calls when they establish a business guarantee, such as avoiding
duplicate delivery, selecting the authenticated owner's role, or sending a queue
message for the committed revision. Avoid assertions about incidental internal
calls, complete configuration tables, generated names, or exact cache durations.

Keep focused tests for complex pure logic, conditional writes, transaction
rollback, query budgets, and migration compatibility. When a broader test protects
the same behavior, remove redundant tests that only inspect its implementation.

## Authentication and scenario setup

Business tests may seed a real user and valid session through fixtures. Requests
still pass through production authentication. Authentication-flow tests exercise
the actual registration, login, verification, linking, and sign-out operations.

Keep shared facilities under `src/test/`. Database tools belong in
`src/test/database/`; scenario fixtures belong in `src/test/fixtures/`, grouped by
business ownership. Tests stay colocated with their production modules.

Prefer small fixture functions with explicit relationships and valid defaults for
incidental fields. Require callers to provide related users or submissions. Extract
shared fixtures when multiple consumers demonstrate reuse.

## Migrated databases

`createTestDatabase()` applies the complete migration chain and returns an empty
business database. Create it in `beforeEach` and call `database.close()` in
`afterEach`. Scenario setup is separate from schema initialization. Historical
migration tests select their starting schema explicitly.

```ts
import { createTestDatabase } from "@/test/database/createTestDatabase";
import { insertAuthenticatedUser } from "@/test/fixtures/auth";
import { insertSubmission } from "@/test/fixtures/submissions";

const database = createTestDatabase();
try {
  const author = insertAuthenticatedUser(database.sqlite, { uid: "author" });
  insertSubmission(database.sqlite, {
    id: "root",
    userId: author.user.uid,
    content: "The entrance is on the east side.",
  });
  // Pass database.db and author.headers to the production HTTP route.
} finally {
  database.close();
}
```

Fixtures write through `database.sqlite`, keeping setup out of recorded production
queries. `database.queries` records SQL, bound values, and changed-row counts.
`database.explain(query)` supports query-plan tests, and
`database.hooks.beforeQuery` supports controlled failure and concurrency scenarios.
Use these facilities when the database guarantee itself is under test.

## Workers runtime tests

Node/Vitest database tests use the shared SQLite/D1 adapter. They verify application
behavior without establishing native Workers scheduling, storage durability,
input/output gates, alarms, distributed KV consistency, or browser cookie enforcement.
The progress runtime fixture supplies isolated storage for production Durable
Object classes; it does not simulate those platform guarantees.

Keep native Workers tests separate. Run `pnpm run test:auth-runtime` and
`pnpm run test:worker-lifecycle` for native request isolation, WebSocket lifecycles,
and D1 transaction behavior. Remote game and delivery providers remain controlled
adapters in those tests. A native test only establishes the operations it observes;
local execution does not establish production provider or CDN reliability.

## Running checks and coverage

Run affected tests with `pnpm exec vitest run <test-file>`. Run
`pnpm run typecheck`, `pnpm run format:check`, and `pnpm run lint` before committing.
`pnpm run check` includes the full ordinary and native suites and deployment dry run.

Run `pnpm run test:coverage` and open `coverage/index.html` for file-level results.
`coverage/coverage-summary.json` is available for comparisons. Reports cover backend
production TypeScript under `src/`, including unimported files, while excluding
tests, fixtures, and pure type modules. Native Workers execution and `oem-logger`
are measured separately from backend Vitest coverage.

Compare reports using the same source scope and exclusions. V8 branch and function
totals can change as new execution paths are collected. Treat uncovered paths as
prompts to investigate missing business behavior. Do not invent unsupported states,
copy configuration into expectations, or retain low-value tests to raise a percentage.
Keep generated reports and development audit records outside version control.
