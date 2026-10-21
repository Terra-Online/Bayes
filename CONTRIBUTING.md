# Contributing to Bayes

Keep changes focused and explain compatibility changes and verification in the
pull request. Follow [coding standards](CODING_STANDARDS.md),
[route conventions](src/routes/README.md), and
[public read conventions](src/publicRead/README.md).

## Setup

Use Node.js 22.12.0+ and pnpm. Docker is needed for local container image conversion.
Some local data files need initialization; follow [data templates](templates/README.md).
See [local development](docs/development.md) for setup and WAF work,
[architecture](docs/architecture.md) for context, and [operations](docs/operations.md)
for deployment. A Cloudflare production account is not required for local checks.

## Checks

- During development, run the affected tests with `pnpm exec vitest run <test-file>`
  and use `pnpm run typecheck` as code changes.
- Before committing, run `pnpm run format:check` and `pnpm run lint`.
- Before pushing, run `pnpm run check`.
- For container changes, also follow the [container checks](containers/oem_imgTrans/README.md#container-regression-checks).

Command definitions live in [package.json](package.json). Review formatter and
lint autofixes before committing; investigate failures before changing expectations.

## Documentation

Do not repeat the same information across documents; keep a single source of truth
and link to it.
Do not restate what code already defines; document decisions, non-obvious reasons,
and conventions that agents might overlook, with code as the source of truth.

Use English for shared guides, matching [Atlos](https://github.com/Terra-Online/Atlos).
Update the owning document with a behavior change. See the
[documentation index](docs/README.md) for destinations.
