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

Middleware declares the Variables it supplies. Retain the app returned by `.use()`
so Hono infers the accumulated Variables for subsequent handlers. Avoid predeclaring
a global Variables inventory with no clear middleware owner for each field.
