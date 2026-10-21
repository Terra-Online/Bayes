# Bayes (Open Endfield Map, Backend Repo)

Bayes is the Cloudflare Workers backend for [Open Endfield Map](https://opendfieldmap.org).
It serves the [Atlos web client](https://github.com/Terra-Online/Atlos), providing
accounts, progress sync, community images and comments, moderation, notifications,
and Endfield account integration. The deployed Worker is named `oem-backend`.

[Contributing](CONTRIBUTING.md) · [Documentation](docs/README.md) ·
[API guide](docs/api.md) · [Discord](https://discord.gg/BFMAKZSUG7)

## What is in this repository?

- **HTTP API**: Hono routes with TypeScript and Zod input validation.
- **Accounts**: Better Auth, email OTP registration, password reset, and social sign-in.
- **Progress**: per-user Durable Objects, D1 persistence, and recoverable statistics delivery.
- **Community content**: R2 images, D1 comments and reactions, public caches, and queued moderation.
- **Live features**: notification and locator WebSockets.
- **Error logging**: a separate Tail Worker in [`oem-logger/`](oem-logger/README.md).

## Getting started

Requirements: Node.js **22.12.0+** and pnpm. Image conversion also needs Docker
when running the container locally.

Follow [local development](docs/development.md) to install dependencies, copy the
data templates, configure services, and initialize local D1. That guide also
covers the fresh-database migration caveat and running without Docker.

The karma template contains zero placeholders. Set your own policy before
exercising karma behavior; no production policy values are included.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md). It covers setup, responsibility
boundaries, focused verification, and pull request expectations. Code and reviews
follow [CODING_STANDARDS.md](CODING_STANDARDS.md).

```sh
pnpm run typecheck
pnpm run lint
pnpm test
```

`pnpm run check` additionally checks formatting, the generated WAF allowlist,
the logger, and native Worker runtime regressions. Deployment is a separate
maintainer operation; see [operations](docs/operations.md).

## Repository layout

```text
src/
  index.ts           Worker fetch, scheduled, and queue entry points
  app.ts             Hono setup, CORS, request IDs, and error handling
  routes/            Topic routers, HTTP schemas, handlers, and HTTP tests
  services/          Domain workflows, Durable Objects, and background work
  repositories/      D1 queries and atomic writes
  publicRead/        Internal cache entrypoint, client, origin loaders, and contracts
  lib/               Authentication, email, external clients, and shared helpers
  test/              Local D1 and native Worker test fixtures
migrations/          Backend D1 migrations
config/              Generated WAF allowlist
containers/          Image transcoder
scripts/             Development, verification, data generation, and deployment
templates/           Local data templates (see templates/README.md)
oem-logger/          Tail Worker and its own D1 migrations
docs/               Contributor documentation
```

## License

This project is licensed under the **GNU Affero General Public License v3.0**.
See [LICENSE](LICENSE). Contributions use the same license.
