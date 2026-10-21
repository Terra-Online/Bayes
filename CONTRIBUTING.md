# Contributing to Bayes

Thank you for helping improve Open Endfield Map. Bayes owns the backend API and
background services; [Atlos](https://github.com/Terra-Online/Atlos) owns the web client.

## 1. Project scope and principles

We value explicit contracts, reliable data writes, efficient public reads, and
changes that another contributor can understand and verify. Preserve existing
API shapes, permissions, concurrency behavior, and data formats unless the task
explicitly changes them. Describe any compatibility change in the pull request.

## 2. Environment setup

Follow [local development](docs/development.md). Use the committed templates
for a fresh checkout, set your own karma policy, and supply service credentials when required. Keep local
configuration and generated game data out of Git. A Cloudflare production account
is not required for source checks and the isolated runtime regression suites.

## 3. Where to make changes

Use the [repository layout](README.md#repository-layout) to find the relevant
module. [Architecture](docs/architecture.md) explains runtime data flow;
[CODING_STANDARDS.md](CODING_STANDARDS.md) defines responsibility boundaries and
adoption status. Follow the [route conventions](src/routes/README.md) and
[public read conventions](src/publicRead/README.md) for those modules.

## 4. Coding and testing

Use explicit types and existing domain utilities. Keep HTTP behavior in routes,
business rules in services, and queries with their repository owner. Do not
introduce a shared abstraction without an actual shared responsibility.

Co-locate tests with the relevant module. Test observable behavior and meaningful
failure cases: ownership checks, cache isolation, concurrent writes, retries, and
cleanup where relevant. Refactors must retain the existing behavior. Investigate
failing tests before changing expectations or mocks.

Run focused checks while developing; use the complete check before pushing:

```sh
# Focus a Vitest run on the changed module.
pnpm test -- src/routes/me/me.spec.ts

# Formatting and lint fixes are separate, repository-wide commands.
pnpm run lint:fix
pnpm run format
pnpm run format:check
pnpm run lint

# Complete verification, including native workerd regressions and logger bundle.
pnpm run check
```

Confirm the test filename exists before using a focused command. See
[verification details](docs/development.md#verification) for runtime and container checks.
Review any formatter or lint autofix diff so unrelated changes stay out of the PR.

## 5. Branches, commits, and pull requests

Use a descriptive branch such as `feature/<name>`, `fix/<name>`, or `docs/<name>`.
Keep commits coherent and use concise imperative messages, for example:
`docs(api): describe progress manifest registration`.

Open a pull request against `main`, link the relevant issue, and explain the
problem, resulting behavior, and actual verification. Include setup requirements
or limitations that affect another contributor's ability to reproduce the result.

Before requesting review:

- [ ] The change is scoped and preserves unrelated behavior.
- [ ] Relevant checks pass; any checks not run and their reasons are stated.
- [ ] Changed API behavior is reflected in [the API guide](docs/api.md).
- [ ] New configuration is documented and has an example without secrets.
- [ ] Schema changes have a migration and have been checked against local D1.
- [ ] Public caches cannot contain account-specific data.
- [ ] No private configuration, user data, production exports, or generated datasets are included.

For a new route prefix, update `src/routes/route.ts`, run `pnpm run waf:sync`,
and include the generated `config/waf-allowlist.json` diff. This generation is
local; applying the allowlist to Cloudflare is a separate operation.

## 6. Documentation and support

Use English for shared contributor guides, matching Atlos. Keep examples usable
from the repository root, link to source owners, and update documentation with
the behavior change. Separate current contracts from dated investigations.
Do not present historical measurements or proposed work as current behavior.

Questions and implementation discussions are welcome in
[Discord](https://discord.gg/BFMAKZSUG7). Contributions are accepted under the
[GNU AGPL v3 license](LICENSE).
