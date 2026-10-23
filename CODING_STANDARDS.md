# Coding standards for agents

This is the agent entrypoint for implementation and review. Agents should apply
these standards incrementally to touched code and report violations with the
affected location and rule.
`Partially adopted` marks agreed rules with known migration work remaining.

Agents should read source code, configuration, and co-located tests for
implementation details. Agents should consult human guides under `docs/` only
when the task explicitly concerns those documents.

## Code responsibilities

- `routes/<topic>/`:
  - Responsible for: Hono handlers, HTTP input validation, middleware composition,
    request identity extraction, status codes, headers, and responses.
  - Not responsible for: business rules, heavy orchestration, or SQL. Simple reads
    may call repositories directly when no separate business orchestration is needed.
  - Partially adopted: existing handlers still contain business workflows and SQL.
- `services/<topic>/`:
  - Responsible for: business rules, permissions, workflow orchestration, and
    transactions across repository calls. Agents should pass explicit, scoped business inputs.
  - Dependencies follow responsibility: orchestration services near HTTP entrypoints may
    accept the complete application `Bindings`. Focused services and repositories should
    accept the specific resources they use, such as `D1Database`; pure functions take data.
  - Call internal services directly. Inject dependencies separately when a real variation
    or runtime lifecycle requires it. Use binding subsets when they clarify a resource
    contract; avoid callback wiring or exact subsets solely to minimize declared dependencies.
  - Not responsible for: Hono context, HTTP responses, or SQL statements.
  - Partially adopted: business workflows are not all Hono-independent, and SQL
    ownership has not been fully separated from services.
- `repositories/<topic>/`:
  - Responsible for: queries, CRUD, row mapping, conditional updates, transactions,
    and atomic writes. Multiple tables may share a repository operation for atomicity.
  - Not responsible for: business policy or HTTP behavior.
- `<domain>/contract/`:
  - Responsible for: definitions, types, and invariants shared within that domain.
  - Not responsible for: collecting unrelated types merely because callers share them.
- `lib/`:
  - Responsible for: small helpers without a business owner, usually pure or with
    limited side effects.
  - Not responsible for: domain workflows or speculative abstractions.
- Tests:
  - Responsible for: observable behavior at meaningful interfaces.
  - Not responsible for: repeating implementation logic, detecting file/code moves,
    or duplicating lint checks.
- Refactoring:
  - Responsible for: preserving API/compatibility behavior, concurrency, and
    atomicity; identifying historical workarounds; keeping business types with owners.
  - Not responsible for: combining responsibility extraction with behavior changes.

## Testing

- **NO TAUTOLOGICAL TESTS OR TESTS THAT REPEAT THE IMPLEMENTATION.**
- Prefer business regression tests through `app.request()` with production routes,
  authentication middleware, and error handling. Check HTTP status, payload, and
  relevant headers; inspect database state to verify persistence and failure side effects.
- Use migration-backed, isolated databases with explicit cleanup. Fixtures may seed
  users, sessions, and scenario data directly; authentication-flow tests exercise the
  actual flow. Historical migration tests use explicit migration ranges.
- Execute internal business code normally. Mock external dependencies with fresh,
  typed mocks that fail on unconfigured operations; reuse `createMockBindings`.
- Assert mock call counts, arguments, or ordering only to verify business orchestration
  or external contracts, such as retry, cancellation, duplicate prevention, or request
  payloads. Distinguish these guarantees from incidental internal calls; explain
  non-obvious expectations in test names or comments.
- Give shared fixtures explicit, named input and return types. Group related results
  by responsibility, such as `{ user, headers }`, and name mocks by their dependency.
- Retain focused unit tests for complex pure logic and specialized tests for migrations,
  transactions, query plans, and native Workers behavior. Keep business assertions
  visible and derive expectations from business rules or external contracts.

### Test naming and organization

- Use `<module-or-business-behavior>.spec.ts` for TypeScript tests. Do not add
  `.integration` or alternate `.test.ts` suffixes. Describe the exercised behavior
  in suite and test names; distinct runtime suites belong in their own runners.
- Split unusually long test files when independent business or domain groups need
  different fixtures or preparation. Group tests with similar setup and dependencies
  together. Line count is a prompt to inspect cohesion, not a mandatory size limit.
- Keep each lifecycle, failure-and-retry sequence, and its assertions together.
  Do not split a cohesive scenario into tests that depend on execution order, or
  fragment a cohesive file only to shorten it.
- Reuse existing fixtures. Extract shared preparation only when multiple test files
  actually need it; put shared facilities under `src/test/fixtures/`. Keep domain
  data and dependency responses local to the groups that need them. Avoid a generic
  scenario DSL, hidden hook registration, or a shared mutable database across tests.

### Schema and invalid-input tests

- Delete schema-rejection examples that only repeat validation-library behavior;
  avoid HTTP, database, authentication, or provider setup solely for these checks.
- Test meaningful normalization, cross-field, and compatibility contracts directly
  in sibling `*.spec.ts` files. Keep domain validators with their domain; avoid
  recreating rejection matrices or asserting library-generated error prose.
- Keep invalid-request integration tests for parsing/forwarding regressions,
  security-sensitive decoding, credential preservation, atomic writes, or retry
  guarantees beyond schema rejection. Unchanged rows or absent provider calls
  alone are insufficient.

## Working guidance

Agents should keep changes focused and explain compatibility changes and
verification in the pull request. Agents should follow
[route conventions](src/routes/README.md) for HTTP work and
[public read conventions](src/publicRead/README.md) for cached public reads.

## Setup

Agents should use Node.js 22.12.0+ and pnpm. Docker is needed for local container
image conversion. Agents should initialize local data files using
[data templates](templates/README.md). Agents should inspect
[wrangler.toml](wrangler.toml) and [.dev.vars.example](.dev.vars.example) for runtime
setup. Agents should read [sync-waf-allowlist.mjs](scripts/sync-waf-allowlist.mjs)
for WAF work and [deploy-with-dev-vars.sh](scripts/deploy-with-dev-vars.sh)
for deployment.
A Cloudflare production account is not required for local checks.

## Checks

- Agents should run the affected tests with `pnpm exec vitest run <test-file>`
  during development and use `pnpm run typecheck` as code changes.
- Agents should run `pnpm run format:check` and `pnpm run lint` before committing.
- Agents should run `pnpm run check` before pushing.
- Agents should also follow the [container checks](containers/oem_imgTrans/README.md#container-regression-checks) for container changes.

Command definitions live in [package.json](package.json). Agents should review
formatter and lint autofixes before committing and investigate failures before
changing expectations.

## Documentation

Agents should keep one authoritative source for each piece of agent guidance
and link to it from directory documents. Code owns implementation facts and
command definitions. Agents should document decisions, non-obvious reasons,
and conventions agents might overlook.

`CONTRIBUTING.md` and `docs/` are for human readers. They may explain steps at
length and repeat agent requirements when that helps a contributor complete a task.
This audience-specific overlap is permitted. Agents should avoid competing
sources within the agent guidance.

The documentation graph contains only links between documentation files. Links
to source code, scripts, and configuration are unrestricted and do not affect
whether a document is a leaf. Agents should keep most documents as leaves with
no outgoing document links and keep the graph acyclic.

Navigation belongs in the root README, CONTRIBUTING, this agent entrypoint, and
`docs/README.md`. Human navigation follows root README to CONTRIBUTING to
`docs/README.md`; the root README also points agents here. Within the human
guides, development may point to operations, and `docs/` may point to the logger
README. Agents should keep these directions one-way and keep leaves free of
links back to an index.

Agents should use English for shared guides, matching Atlos, and update the
owning document with a behavior change.
