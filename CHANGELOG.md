# Changelog

## 0.9.1

### Patch Changes

- 14b167d: Correct package keywords to reflect the full SDK surface — REST, storage, auth, and MySQL — not just GraphQL/Postgres.

All notable changes to `@excalibase/sdk`.

## 0.9.0

### BREAKING

- **Removed `.watch()` reactive subscriptions.** Every
  `db.functions.<module>.<name>(args)` call now returns a plain `Promise`
  instead of a `LazyQuery`. The `.watch()` method, the multiplexed
  WebSocket, the read-key envelope, and the SDK-side dependency tracker
  all go away.
- `createClient` no longer accepts `wsUrl`. The field is removed from
  `CreateClientOptions`; passing it is a type error.
- `DbClient.functions_closeReactive()` is gone. Apps that previously
  called it on teardown can remove the call.

### Removed

- `src/functions/reactive_ws.ts` (whole module — `ReactiveWebSocket`,
  `SubError`, the graphql-transport-ws subprotocol implementation).
- Public type exports: `LazyQuery`, `FunctionsSubscription`,
  `ReactiveWebSocket`, `SubError`.
- `docs/reactive-queries.md`.
- `test/functions-watch.test.ts`.

### Migration

```ts
// Before:
const sub = db.functions.posts.list({}).watch();
sub.onUpdate((rows) => render(rows));

// After: re-fetch when you know the data changed. The graphql
// subscription endpoint (`db.graphql.subscribe(...)`) and the REST CDC
// WebSocket (`/api/v1/realtime`) are the supported reactive substrates;
// re-invoke the function inside the subscription's onUpdate.
```

## 0.8.0 — 2026-05-15

### BREAKING

- **`.watch()` reactive subscriptions speak the collection-CDC protocol on
  graphql's existing `/graphql` WebSocket.** The previous
  function-subscription protocol (`{op:"subscribe-function", ...}` →
  `{op:"function-result"}`) is gone — it never existed on the graphql side
  in the new architecture, so any client that spoke it was broken in
  practice. The orchestrator now lives in the SDK:
  1. HTTP-invoke the function with `X-Excalibase-Envelope: v1` to receive
     `{result, reads}`.
  2. Open one WS per `db` client to `ws(s)://<graphql-host>/graphql` with
     the `graphql-transport-ws` subprotocol; perform the
     `connection_init` / `connection_ack` handshake.
  3. Send one lightweight subscribe frame per dependency:
     `{id, type:"subscribe", source, collection}`.
  4. On any `{type:"next", id, op, doc}` for a watched table, re-invoke
     the function over HTTP, SHA-256-hash the result, dedup, and fire
     `onUpdate` only when the hash differs.
  5. Bursts coalesce per sub: at most one invoke is in flight; a trailing
     invoke fires once if events arrived during the running one.

- **`createClient({ wsUrl })` format changed.** The previous value pointed
  at graphql's `/api/v1/realtime` endpoint. The new value is graphql's
  `/graphql` endpoint (same one used for queries / mutations) — both
  function-reactive subscriptions and collection-level CDC subscriptions
  multiplex onto a single WS over the `graphql-transport-ws` subprotocol.

  ```diff
   const db = createClient({
     url: "http://localhost:10000",
     projectId: "acme/prod",
     publishableKey: "esk_pub_live_...",
  -  wsUrl: "ws://localhost:10000/api/v1/realtime",
  +  wsUrl: "ws://localhost:10000/graphql",
   });
  ```

  No `.watch()` call-site changes are required. Upgrading the SDK without
  updating `wsUrl` will surface as a `SubError({code:"auth_timeout"})`
  because the old endpoint never sends `connection_ack` for an
  unrecognized handshake.

- **Wire protocol change (post-handshake).**

  | Direction       | Old frame                                     | New frame                                                           |
  | --------------- | --------------------------------------------- | ------------------------------------------------------------------- |
  | Client → Server | `{op:"subscribe-function", ...}`              | `{id, type:"subscribe", source, collection}`                        |
  | Client → Server | `{op:"unsubscribe-function", subId}`          | `{id, type:"complete"}`                                             |
  | Server → Client | `{op:"function-result", subId, data}`         | `{type:"next", id, op, doc}` (consumed; SDK orchestrates re-invoke) |
  | Server → Client | `{op:"function-error", subId, code, message}` | `{type:"error", id, payload:{message}}` (logged)                    |

- **HTTP envelope opt-in.** `await db.functions.x.y(args)` still posts
  without `X-Excalibase-Envelope` and unwraps `{data}` for back-compat.
  `.watch()` and its CDC-triggered re-invokes always send the envelope
  header; the server must return `{result, reads}` in that case.

### Internals

- `FunctionsNamespace._invokeWithEnvelope(...)` is now the entry the
  reactive orchestrator uses; `_postFunction` is the shared transport.
- `ReactiveWebSocket` now takes an `invoke` callback instead of speaking
  the function-subscription wire op directly. The `projectId` option is
  no longer used by the WS layer — projects are encoded in the function
  URL on the HTTP side.

### Migration

```diff
 const db = createClient({
   url: "http://localhost:10000",
   projectId: "acme/prod",
   publishableKey: "esk_pub_live_...",
-  wsUrl: "ws://localhost:10000/api/v1/realtime",
+  wsUrl: "ws://localhost:10000/graphql",
 });

 const sub = db.functions.posts.list({}).watch();
 sub.onUpdate((posts) => render(posts));
```

## 0.7.0 — 2026-05-13

### BREAKING

- **Relaxed `createClient` `projectId` regex.** The previous regex only
  accepted the slash form `{orgSlug}/{projectName}`. Provisioning emits
  opaque project ids (e.g. `proj-fuekhuce64`) that don't carry a slash,
  so external consumers (e2e suite, dev CLI) had to bypass `createClient`
  and construct `FunctionsNamespace` directly. The new regex is
  `^[a-zA-Z0-9_\-./]{1,128}$` — both forms are now accepted.

  For opaque ids the `db.orgSlug` and `db.projectName` fields both fall
  back to the full id (rather than `undefined`). `db.authEndpoint()` and
  every other internal consumer continue to produce well-formed URLs.

  Existing slash-form callers (`projectId: "acme/prod"`) are
  unaffected — the regex still matches, and the split-on-`/` derivation
  still yields the original two segments.

  This is marked BREAKING because callers that previously passed an
  invalid id (e.g. `bad@id`) and relied on the ConfigError to fire will
  still throw — but the _message_ changed to mention the new regex.

### Added

- **`FunctionsNamespace` is a first-class public export.** The class was
  always re-exported from `src/index.ts`, but Phase 9b.H now pins this
  via an explicit unit test (direct `new FunctionsNamespace(opts)`
  construction with `wsUrl` + `jwtProvider`, exercising the Proxy +
  `.watch()` shape). External callers — the reactive e2e suite and the
  upcoming dev-CLI — depend on this contract.

## 0.6.0 — 2026-05-13

### Added

- **`db.storage.uploadFile(blob, opts?)`** — Convex-shape file-storage
  client. Wraps the direct-upload pattern in one call: the SDK invokes a
  developer-authored mutation that mints a signed PUT URL via
  `ctx.storage.generateUploadUrl()`, PUTs the blob bytes directly to
  that URL, and returns `{ storageId }`.

  ```ts
  const blob = await fetch("/local/file.png").then((r) => r.blob());
  const { storageId } = await db.storage.uploadFile(blob);
  await db.functions.messages.sendImage({ storageId, author: "alice" });
  ```

  By convention the SDK calls `api.system.generateUploadUrl`. Override
  via `opts.ref`:

  ```ts
  await db.storage.uploadFile(blob, {
    ref: { moduleName: "photos", exportName: "signUpload" },
  });
  ```

### BREAKING

- **`db.storage` is now the file-storage client** (Phase 10). The auth-
  session persistence adapter moves to `db.tokenStorage`. The
  `createClient({ storage })` option still configures the token adapter
  for backwards-compat, but reading `db.storage` now returns the file
  client. Callers that read the token adapter off `db.storage` need to
  switch to `db.tokenStorage` — a one-line rename in app code.

## 0.5.0 — 2026-05-12

### BREAKING

- **`db.functions.<m>.<n>().watch()` now connects to the graphql server's
  `/api/v1/realtime` WebSocket** (was a Deno-runtime sibling port). One WS
  per `db` client is multiplexed across function-level subscriptions and
  collection-level CDC subscriptions on the same endpoint.
- **Wire protocol change.** Before sending any subscribe frames, the SDK
  performs a GraphQL-WS-style auth handshake:
  - Client → Server: `{"type":"connection_init","payload":{"Authorization":"Bearer <jwt>"}}`
  - Server → Client: `{"type":"connection_ack"}`
    If no ack arrives within 5 s (or the server closes before ack), every
    pending subscription receives `SubError({code:"auth_timeout"})`.
- **Frame op-names renamed:**
  - `{op:"subscribe", ...}` → `{op:"subscribe-function", subId, projectId, ref, args}`
  - `{op:"unsubscribe", ...}` → `{op:"unsubscribe-function", subId}`
  - `{op:"result", ...}` → `{op:"function-result", subId, data, pageStatus?}`
  - `{op:"error", ...}` → `{op:"function-error", subId, code, message}`
- **No more `?token=<jwt>` query param.** The JWT is sent in the
  `connection_init` payload instead.
- **No more application-level `ping`/`pong` frames.** graphql uses native
  WebSocket ping/pong, which browsers and the `ws` library handle
  transparently.
- **`wsUrl` format changed.** Old format pointed at a Deno sibling port:
  `ws://localhost:<wsPort>/functions/v1/{projectId}/_watch`. New format:
  `ws://<graphql-host>/api/v1/realtime`.

### Migration

```diff
 const db = createClient({
   url: "http://localhost:10000",
   projectId: "acme/prod",
   publishableKey: "esk_pub_live_...",
-  wsUrl: "ws://localhost:10001/functions/v1/acme/prod/_watch",
+  wsUrl: "ws://localhost:10000/api/v1/realtime",
 });
```

No call-site changes are required — `db.functions.x.y(args).watch()` works
exactly the same. The protocol change is internal to the SDK. Users who
upgrade the SDK without updating `wsUrl` will see `auth_timeout` errors
because the old Deno sibling port does not understand `connection_init`.

## 0.4.0 — 2026-05-12

### BREAKING

- **Removed `db.nosql.collection(...)` and `db.collection(...)`.** The
  collection-style namespace and its top-level shortcut, deprecated in
  0.3.0, are gone. Migrate to typed functions via
  `db.functions.<module>.<name>(args)` — bundles can declare
  `schema.ts` for collection/index creation at deploy time, matching the
  Convex shape the rest of the SDK now follows.
- **Removed `db.init(schema)`.** Schema declaration moved to function
  bundles (`schema.ts`); admin/runbook flows that need a side-channel use
  the internal-only `POST /internal/nosql/schema/sync` endpoint on the
  graphql server.
- **Removed exports** `NoSqlNamespace`, `CollectionClient`,
  `defineSchema`, `defineCollection`, `resetNoSqlDeprecationWarning`,
  `SchemaDeclaration`, `CollectionDef`, `NoSqlIndexDef`, `FindOptions`,
  `UpdateOp`. They no longer have a backing surface on the server.

### Migration

```ts
// Before (0.3.x)
await db.nosql.collection("posts").insertOne({ title: "Hello" });
const posts = await db.nosql.collection("posts").find({ status: "draft" });

// After (0.4.x)
await db.functions.db.insert({ collection: "posts", doc: { title: "Hello" } });
const posts = await db.functions.db.find({
  collection: "posts",
  filter: { status: "draft" },
});
```

## 0.3.0 — 2026-05-11

### Added

- `db.functions.<module>.<name>(args)` — typed HTTP RPC namespace backed by a
  two-level `Proxy`. Each call POSTs to
  `${url}/functions/v1/${projectId}/${moduleName}.${exportName}` with
  `{ args }`. The response `{ data }` is unwrapped; `{ error, issues? }`
  throws `FunctionsError`.
- `createClient<Database, Functions>` — second generic for the new
  `db.functions` namespace. Defaults to `DefaultFunctions` (any module/export).
  Pair with codegen output for full call-signature types.
- `excalibase-codegen functions` — new CLI subcommand. Reads
  `GET /api/projects/{projectId}/functions/_metadata` and emits
  `functions.types.ts` mapping `module → export → FunctionRef<Args, unknown>`.
  Args interfaces are compiled from each export's `argsJsonSchema` via
  `json-schema-to-typescript`.
- `FunctionsNamespace`, `FunctionsError`, `FunctionRef`, `DefaultFunctions`,
  `ValidationIssue` — public types re-exported from `index`.

### Deprecated

- `db.nosql.collection(...)` and `db.collection(...)` now emit a one-shot
  `console.warn` pointing to `db.functions`. The collection API itself
  remains functional — removal is scheduled for the next major release.

### Notes

- `TResult` on `FunctionRef<TArgs, TResult>` is `unknown` for this release;
  return-type metadata lands once the runtime starts emitting it.
- `json-schema-to-typescript` moved from `devDependencies` to `dependencies`
  so `npx excalibase-codegen functions` resolves it at user dev time.
