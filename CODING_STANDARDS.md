# Coding standards

Follow these standards when writing or reviewing code. Reviews must identify
violations with the affected location and rule. Apply incrementally to touched code.
`Partially adopted` marks agreed rules with known migration work remaining.

- `routes/<topic>/`:
  - Responsible for: Hono handlers, HTTP input validation, middleware composition,
    request identity extraction, status codes, headers, and responses.
  - Not responsible for: business rules, heavy orchestration, or SQL. Simple reads
    may call repositories directly when no separate business orchestration is needed.
  - Partially adopted: existing handlers still contain business workflows and SQL.
- `services/<topic>/`:
  - Responsible for: business rules, permissions, workflow orchestration, and
    transactions across repository calls. Accept scoped inputs and dependencies.
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
