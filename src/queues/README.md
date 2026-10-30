Cloudflare Queues separate publishing work from consuming it in a later Worker invocation.

Paths below are relative to this directory (`src/queues/`), except paths starting with `src/`, which are relative to the repository root.

`src/index.ts` registers `runtime/entrypoint.ts` as its `queue` handler. Queue messages use the current contract in `types/messages.ts`; producers and consumers change together.

- `client/`: Producer operations. Routes, scheduled jobs, and services enqueue work through these entrypoints.
- `types/`: Public queue message types and their tagged union.
- `runtime/`: Cloudflare dispatch, batch handling, acknowledgement, and retries. Consumers call business services with ordinary inputs.

Business decisions and workflows stay in `src/services/`. Keep failure boundaries when moving consumers: translation prewarm failures are logged and acknowledged, while notification enqueue failures retry the message.
