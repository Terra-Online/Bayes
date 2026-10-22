# Testing for refactoring

The testing direction is to protect observable business behavior while allowing
internal code to move between routes, services, and repositories.

Most business regression tests should send requests through the Hono HTTP
interface, exercise internal application code, use a local database, and inspect
the resulting database state as well as the HTTP response. Mock external
services such as email delivery. Avoid mocking internal application modules.
Use focused unit tests for modules whose behavior benefits from independent
verification.

## Authentication and scenario setup

Business tests may create a real user and valid session directly through test
helpers. Requests should still pass through the production authentication
middleware. Tests of authentication itself should exercise the relevant real
registration, login, verification, and session flows.

## Database structure

Ordinary database tests should build the current schema from the complete
migration chain. Scenario fixtures should prepare data separately from schema
creation. Historical migration tests should prepare the historical starting
structure explicitly rather than use current-schema fixtures.

Measure initialization cost before choosing optimizations.

## Current scope

The current work focuses on organizing existing tests and extracting reusable
fixtures and database test utilities:

- Consolidate duplicate SQLite/D1 adapters while preserving capabilities used
  by existing tests.
- Move ordinary database tests toward schema initialization from the full
  migration chain.
- Separate database initialization, scenario data, authentication setup, and
  HTTP request preparation.
- Use the existing public-comment repository and HTTP integration tests as the
  pilot without adding a new business test suite.
- Inventory coverage gaps and establish a coverage measurement baseline.

Keep existing tests that deeply mock internal behavior, including SQL-string
matching fakes, outside this consolidation unless a change is necessary to
extract shared facilities. Record their limitations. Report and fix actual
errors or ineffective assertions discovered during the work explicitly.

Adding business coverage and broadly rewriting mock-heavy tests are outside
the current scope. Numerical coverage gates are also outside this scope.

## Runtime and isolation

Ordinary database tests continue to run in Node/Vitest using SQLite through a
shared D1 adapter. Each test gets an independent database; central helpers own
initialization and cleanup. A test specifically exercising a sequence of
requests or a resource lifecycle may share state within that explicit scenario.

Keep the native Workers regression suites separate. Their request isolation,
WebSocket, timer, and native D1 checks require that runtime, and their deliberate
historical or reduced schema setups are outside this consolidation.

## Fixture conventions

Keep shared facilities under `src/test/`, separating generic database tools
from fixtures grouped by business ownership. Existing tests stay colocated
with their production modules.

Prefer small creation functions with explicit business relationships. Provide
valid defaults for incidental required fields, allow relevant overrides, and
require callers to supply related users or other entities. Avoid implicitly
creating associated records or introducing a general builder framework.

Extract facilities for demonstrated reuse.

## Implementation plan

The public-comment tests are the first batch, not the completion boundary.
Continue through existing real SQLite tests, including authentication, images,
notifications, and binding where applicable. Preserve meaningful scenarios and
assertions while removing duplicated adapters, schemas, and setup. Explicit
historical-schema tests keep their historical setup.

Use these locations:

- `src/test/database/sqliteD1.ts`: shared Node SQLite implementation of the D1 operations
  used by tests, including transactional batches and existing instrumentation.
- `src/test/database/migrations.ts`: discover and apply migration files, retaining the
  ability to apply explicit historical ranges.
- `src/test/database/createTestDatabase.ts`: initialize an independent migrated test database and
  provide a consistent cleanup interface.
- `src/test/fixtures/`: small domain-owned data creation functions, including
  users, authentication sessions, and submissions as consumers require them.

Group database infrastructure under `src/test/database/`; colocate migration
and adapter tests there as they are organized. Consumers import the owning
module directly, for example `@/test/database/createTestDatabase`. A barrel export is not
needed. Business scenario fixtures remain separate under `src/test/fixtures/`.

Preserve existing helper interfaces with thin wrappers during migration where
that keeps changes reviewable; remove duplicate implementations and unused
wrappers once their consumers have moved.

Work in this order:

1. Establish the existing test result and coverage baseline, and inventory
   database helper consumers.
2. Consolidate database execution and migration initialization. Preserve used
   capabilities such as query recording, query plans, failure injection,
   parameter binding, and rollback.
3. Migrate the existing public-comment repository and HTTP tests to the shared
   database and scenario fixtures.
4. Migrate remaining real SQLite test consumers in domain-sized batches.
5. Compare test results and coverage, review remaining exceptions and gaps,
   and complete project validation.

Do not add business test suites as part of this work. Focused infrastructure
tests are appropriate when needed to verify meaningful shared behavior such as
transaction rollback or binding semantics. Do not add tests that merely assert
file placement or repeat the implementation.

## Coverage baseline

Measure ordinary Vitest coverage of backend production TypeScript under `src/`,
including files not imported by tests. Exclude test files, `src/test/`, and pure
type declarations. Provide an overall summary and file-level details.

Native Workers regression results remain separate from that percentage.
`oem-logger` is also outside the backend coverage baseline and should have its
boundary stated explicitly. Coverage reports identify omissions; this work
does not introduce percentage gates.

## Acceptance

Existing meaningful test scenarios and assertions remain protected. Migrated
ordinary database tests use the actual migration chain and valid fixture data,
run independently, and release their databases. Shared tooling retains the
capabilities its consumers require. Historical-schema and native runtime
exceptions are explicit.

Run affected tests and type checking during implementation, then formatting,
lint, the full ordinary test suite, and existing runtime regressions. Record
any unavailable checks or failures with their cause. Compare the baseline and
final coverage and summarize remaining gaps without expanding implementation
scope to fill them.

## Using the facilities

`createTestDatabase()` returns an empty business database with the complete
migration chain applied. Create it in `beforeEach` and call `database.close()`
in `afterEach`. It also closes the connection if initialization fails.

```ts
import { createTestDatabase } from "@/test/database/createTestDatabase";
import { insertSubmission } from "@/test/fixtures/submissions";
import { insertUser } from "@/test/fixtures/users";

const database = createTestDatabase();
const author = insertUser(database.sqlite, { uid: "author" });
const root = insertSubmission(database.sqlite, {
  id: "root",
  userId: author.uid,
  content: "Root comment",
});
insertSubmission(database.sqlite, {
  id: "reply",
  userId: author.uid,
  parentId: root.id,
  depth: 1,
});
// Pass database.db to production code, then inspect HTTP results and stored data.
database.close();
```

Fixtures write through `database.sqlite`, keeping scenario setup out of the
recorded production queries. `database.queries` contains SQL, bound values,
and changed-row counts. `database.explain(query)` inspects its query plan.
`database.hooks.beforeQuery` supports existing failure-injection scenarios.
The adapter implements the D1 operations used here; native metadata, runtime
isolation, and broader D1 API parity remain the Workers suites' responsibility.

For authenticated business requests, explicitly prepare both the business user
and the login user in the current two-table model, then seed a session:

```ts
import { insertAuthUser, insertSession, testAuthConfig } from "@/test/fixtures/auth";

const identity = insertAuthUser(database.sqlite, {
  id: author.uid,
  email: author.email,
});
const session = insertSession(database.sqlite, { userId: identity.id });
const response = await app.request(path, { headers: session.headers }, {
  DB: database.db,
  ...testAuthConfig,
});
```

`insertAuthUser` does not create a business user, and `insertSession` does not
create either user. Requests pass through real authentication middleware.
The `/me` and binding HTTP tests provide working examples. The named
`seedImageReadScenario` fixture preserves an existing shared image dataset;
new scenarios can use the individual creation functions instead.

## Coverage and remaining gaps

Run `pnpm run test:coverage`. Open `coverage/index.html` for file-level results;
`coverage/coverage-summary.json` is available for comparison tools. The report
excludes pure type modules explicitly; `submission/types.ts` remains included
because it also exports a runtime value. Vitest and its coverage provider are
pinned to the same version.

The 2026-10-22 consolidation retained 497 existing Vitest tests and added two
adapter behavior tests. All 499 pass. The separate native Workers suites have
16 passing tests. The backend baseline and final report, using the same file
scope, are:

| Metric | Before | After |
| --- | --- | --- |
| Lines/statements | 59.64% | 59.65% |
| Functions | 72.22% | 72.22% |
| Branches | 75.52% | 75.14% |

The original baseline included seven type-only modules; the figures above
exclude their synthetic coverage entries to match the final scope. More
realistic fixture fields reduce incidental coverage of null/default fallbacks
in user and submission mapping. Real authentication improves middleware
coverage. Branch totals also depend on the V8 execution paths collected; the
percentage is a gap indicator rather than an acceptance gate. Detailed local
comparison evidence is kept under `docs/local/test-foundation/` and is ignored
by Git, as are the generated HTML reports.

Known limitations and exceptions:

- Moderation core, comment translation, locator tickets, and official marker
  synchronization have under 6% line coverage in this baseline. No business
  coverage was added for those areas.
- The progress consistency suite still interprets SQL through a Map-backed
  fake. Some upload policy and session-exchange tests still mock internal
  collaborators. Consolidating their real SQL stores does not establish the
  complete business integration path.
- Historical index and notification-cleanup tests deliberately stop at a
  migration boundary. Adapter tests use a small synthetic table to verify
  parameter binding and rollback.
- Native Workers suites retain their deliberately reduced or historical
  database setups and their independent execution commands.

Production source and migrations are unchanged. The coverage dependency adds
its development tooling to the lockfile; existing production authentication
and application Zod resolutions are preserved.
