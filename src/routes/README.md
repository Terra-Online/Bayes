# Routes

- App mounting: `route.ts` is the single entry to consult.
- HTTP input schemas: `schema/<topic>.ts`.
- Topic handlers and tests: `<topic>/`, entered through `createRoutes.ts`.
- Special cases: `notify/liveUpgrade.ts` for the Worker-level upgrade path;
  `binding/` for legacy mixed workflows and the shared local lookup asset.

Middleware declares the Variables it supplies. Retain the app returned by `.use()`
so Hono infers the accumulated Variables for subsequent handlers. Avoid predeclaring
a global Variables inventory with no clear middleware owner for each field.
