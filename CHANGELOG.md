# Changelog

All notable changes to `@excalibase/sdk`.

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
