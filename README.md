# Bayes (Open Endfield Map, Backend Repo)

Bayes is the Cloudflare Workers backend for [Open Endfield Map](https://opendfieldmap.org).
It serves the [Atlos web client](https://github.com/Terra-Online/Atlos), providing
accounts, progress sync, community images and comments, moderation, notifications,
and Endfield account integration.

[Contributing](CONTRIBUTING.md) · [Documentation](docs/README.md) ·
[API guide](docs/api.md) · [Discord](https://discord.gg/BFMAKZSUG7)

## What is in this repository?

- **HTTP API**: Hono routes with TypeScript and Zod input validation.
- **Accounts**: Better Auth, email OTP registration, password reset, and social sign-in.
- **Progress**: per-user Durable Objects, D1 persistence, and recoverable statistics delivery.
- **Community content**: R2 images, D1 comments and reactions, public caches, and queued moderation.
- **Live features**: notification and locator WebSockets.
- **Error logging**: a separate Tail Worker in [`oem-logger/`](oem-logger/README.md).

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) to set up the project and prepare a contribution.

## License

This project is licensed under the **GNU Affero General Public License v3.0**.
See [LICENSE](LICENSE). Contributions use the same license.
