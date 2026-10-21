# Routes

- App mounting: `route.ts` is the single entry to consult.
- HTTP input schemas: `schema/<topic>.ts`.
- Topic handlers and tests: `<topic>/`. Each route module exports `createRoutes()`
  and creates and returns its own Hono app. Larger topics may use multiple
  `fooRoutes.ts` modules; mount them in `route.ts` at the same URL prefix in order.
  Keep fallback routes last. `createRoutes()` must not accept a shared app.
- Special cases: `notify/liveUpgrade.ts` for the Worker-level upgrade path;
  `binding/` for legacy mixed workflows and the shared local lookup asset.

Define handlers inline where routes are registered. Moving the implementation
elsewhere does not reduce complexity; keeping it inline also lets Hono infer
the Variables supplied by middleware.

Register each app's middleware and endpoints with chained Hono calls. Keep `.use()`
in the chain so Hono infers the Variables supplied by middleware for subsequent
handlers. Avoid predeclaring a global Variables inventory with no clear middleware
owner for each field.
