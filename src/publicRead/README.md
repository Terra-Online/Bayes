Make use of Cloudflare's `Workers Cache` to cache public content reads.

`src/index.ts` exports the `PublicReadCache` entrypoint. `wrangler.toml` enables caching on that entrypoint. Hono handlers use this internal endpoint through the `client` to benefit from the cache.

- `client/`: This is all that a Hono handler should know: reads, scope helpers, response types, and invalidation.
- `origin/`: The entrypoint from Cloudflare and the implementation, including KV and database loading on cache misses.
- `contract/`: Shared request encoding and parsing, response types, list limits, cache keys, and purge tags used by `client` and `origin`.
