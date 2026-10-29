# Isolated Cor management contract check

This opt-in suite loads the actual Cor `src/api.ts` from an installed checkout.
Set `COR_REPO_ROOT` to that checkout. Run from the Bayes checkout under test:

```sh
COR_REPO_ROOT=/path/to/Cor node node_modules/vitest/vitest.mjs run --config scripts/vitest.cor.config.ts
```

Bayes dependencies and owner-provided ignored data must be set up as for the
normal test suite. The suite uses the existing migration-backed SQLite D1 test
adapter with the latest registered schema, seeds real authentication sessions,
and forwards Cor fetch requests to the production Hono moderation routes through
`app.request`. Cookie credentials and actor authorization run normally. External
Redis, Workers cache invalidation and queue/live delivery use the existing test
adapters. No network listener, remote API, production data or credentials are used.

The harness rejects unexpected fetch origins. It proves actual client payloads,
returned read facts, authentication, exact snapshot/phase conflicts, early manual
takeover, independent bulk commits, terminal facts and old hidden report traversal.
Cor's own mounted React tests separately prove click capture, button behavior,
pagination reset and error presentation. This suite does not claim browser,
Cloudflare Access, deployed-cookie or production integration validation. It is
excluded from the ordinary Bayes suite because Cor is a separate repository.

The config can also be invoked with `--root /path/to/Bayes` when running elsewhere.
The config and fixture imports resolve from the Bayes checkout that owns them.
