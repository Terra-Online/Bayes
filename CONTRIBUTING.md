# Contributing to Bayes

Thank you for helping improve Open Endfield Map. Bayes owns the backend API and
background services; [Atlos](https://github.com/Terra-Online/Atlos) owns the web client.
This guide is for human contributors.

## Project scope and principles

We value explicit contracts, reliable data writes, efficient public reads, and
changes that another contributor can understand and verify. Preserve existing
API shapes, permissions, concurrency behavior, and data formats unless the task
explicitly changes them. Describe any compatibility change in the pull request.

## Environment setup

Use Node.js 22.12.0+ and pnpm. Docker is needed for local container image conversion.
Some local data files need initialization; follow [data templates](templates/README.md).
Then follow [local development](docs/development.md) to configure and run the backend.
A Cloudflare production account is not required for local checks.

If you are new to the project, [architecture](docs/architecture.md) introduces the
runtime data flow, and the [API guide](docs/api.md) helps you explore the endpoints.
Deployment is covered separately in [operations](docs/operations.md).

## Preparing a contribution

Run focused checks while developing; use the complete check before pushing:

```sh
pnpm exec vitest run <test-file>
pnpm run typecheck
pnpm run format:check
pnpm run lint
pnpm run check
```

Review any formatter or lint autofix diff so unrelated changes stay out of the PR.
Investigate failing tests before changing expectations or mocks.

Open a pull request against `main`, link the relevant issue, and explain the
problem, resulting behavior, and actual verification. Include setup requirements
or limitations that affect another contributor's ability to reproduce the result.

## Documentation and support

The [documentation index](docs/README.md) points to the guide for each task.
The guides in `docs/` are written for people: they can take time to explain the
steps and the context needed to carry them out.

Questions and implementation discussions are welcome in
[Discord](https://discord.gg/BFMAKZSUG7). Contributions are accepted under the
GNU AGPL v3 license.
