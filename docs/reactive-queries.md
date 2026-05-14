# Reactive queries — `db.functions.<m>.<n>().watch()` + typed `api` graph

Every `db.functions.<module>.<name>(args)` call returns a thenable for `await`
(one-shot HTTP) AND exposes `.watch()` to subscribe to reactive updates over
WebSocket.

Codegen emits a parallel typed `api`/`internal` value graph alongside
`functions.types.ts`. Pass a ref like `api.users.list` to function runtime
helpers (`ctx.runQuery`, `ctx.runMutation`) and TS infers both `args` and the
return type from the ref.

## Architecture

```
QUERY / MUTATION / ACTION  ── SDK ──HTTP──> provisioning ──> functions runtime
                                            returns { result, reads }

REALTIME EVENTS            ── SDK ──WS────> graphql collection-CDC
                                            graphql-transport-ws subprotocol

.watch() orchestration lives entirely in the SDK:
  1. SDK invokes the function via HTTP with `X-Excalibase-Envelope: v1`
     and receives `{ result, reads }`. `reads` is the list of CDC source
     keys (e.g. `"nosql_posts"`, `"public_users"`) the handler depended on.
  2. SDK opens one WS per `db` client to graphql's `/graphql` endpoint,
     sends `{type:"connection_init"}`, waits for `{type:"connection_ack"}`.
  3. Per dependency in `reads`, SDK sends
     `{id, type:"subscribe", source, collection}`.
  4. On `{type:"next", id, op, doc}` matching a sub's table-sub id, SDK
     re-invokes the same function over HTTP, hashes the result with
     SHA-256, dedups, and fires `onUpdate(data)` only when the hash differs.
  5. `close()` sends `{id, type:"complete"}` for each per-table sub.
```

graphql is a "dumb" CDC pipe — it just streams raw collection events. The SDK
is responsible for translating those events into query-level updates. Because
re-invocation goes back over HTTP, a query with high handler latency produces
correspondingly delayed reactive updates.

## Two paths, same metadata

| Path | Use case | Typed? |
|------|----------|--------|
| `db.functions.users.list(args)` | Client-side RPC over HTTP / WS | Yes (via `Functions` generic) |
| `ctx.runQuery(api.users.list, args)` | Function-to-function calls server-side | Yes (via `FunctionRef<Args, Result>`) |
| `ctx.runMutation(internal.admin.cleanup, args)` | Internal-only graph (never exposed to clients) | Yes |

Codegen emits BOTH `functions.types.ts` (the type-only `Functions` interface)
and `api.ts` (the runtime value graph) from the same metadata endpoint:

```bash
npx excalibase-codegen functions \
  --url https://api.example.com \
  --project acme/prod \
  --token $JWT \
  --out src/functions.types.ts \
  --api-out src/api.ts        # optional; default: <dirname(--out)>/api.ts
```

## Quick start

```ts
import { createClient } from "@excalibase/sdk";

const db = createClient({
  url: "http://localhost:10000",
  projectId: "acme/prod",
  publishableKey: "esk_pub_live_...",
  // Points at graphql's /graphql endpoint (graphql-transport-ws
  // subprotocol). Multiplexed across all watch subs on this client.
  // Required for `.watch()`. Omit it to disable reactive.
  wsUrl: "ws://localhost:10000/graphql",
});

// One-shot HTTP
const initial = await db.functions.posts.list({ status: "published" });

// Reactive
const sub = db.functions.posts.list({ status: "published" }).watch();
const unsub = sub.onUpdate((posts) => render(posts));
sub.onError((err) => console.error(err.code, err.message));

// Tear down
unsub();
sub.close();
```

## API

### `LazyQuery<T>`

Returned from every `db.functions.<m>.<n>(args)` call.

- `await query` — one-shot HTTP POST (no envelope header; back-compat `{data}` unwrap).
- `query.watch()` — open a reactive subscription. Returns a `Subscription<T>`.

### `Subscription<T>`

```ts
interface Subscription<T> {
  onUpdate(handler: (data: T) => void): () => void;
  onError(handler: (err: SubError) => void): () => void;
  close(): void;
}

interface SubError {
  code: string;     // "auth_timeout" | "invoke_error" | "subscribe_failed" | ...
  message: string;
}
```

### `createClient({ wsUrl })`

`wsUrl` points at graphql's `/graphql` endpoint. The SDK opens the WS with the
`graphql-transport-ws` subprotocol.

```
ws(s)://<graphql-host>:<port>/graphql
```

When `wsUrl` is omitted, calling `.watch()` throws a clear error. `await` calls
still work without `wsUrl`.

## Wire protocol

The SDK speaks two protocols:

### HTTP — function invoke (envelope on `.watch()`)

```
POST {url}/functions/v1/{projectId}/{module}.{export}
Headers:
  Authorization: Bearer <jwt>
  X-Excalibase-Envelope: v1     # added only by .watch() / re-invokes
  Content-Type: application/json
Body: {"args": <args>}
Response (envelope on):  {"result": <handler return>, "reads": ["nosql_posts", "public_users"]}
Response (envelope off): {"data":   <handler return>}                 # back-compat
```

`await db.functions.x.y(args)` does NOT send the envelope header — it preserves
the existing `{data}` unwrap. Reactive invocations always do.

### WebSocket — collection-CDC

After WS open:

```json
client → server: {"type":"connection_init"}
server → client: {"type":"connection_ack"}
client → server: {"id":"u1-t1","type":"subscribe","source":"nosql","collection":"posts"}
server → client: {"type":"next","id":"u1-t1","op":"insert","doc":{...}}
server → client: {"type":"next","id":"u1-t1","op":"update","doc":{...}}
client → server: {"id":"u1-t1","type":"complete"}
```

`source` values: `"nosql"` (NoSQL collections), `"public"` / `"rest"` (SQL
tables). Read keys (server-emitted in the envelope's `reads` array) are
`<source>_<collection>`; keys without an `_` default to `source="public"`.

### Auth handshake

The JWT is captured per (re)connect via the SDK's `jwtProvider`. If no
`connection_ack` arrives within 5 s, every pending sub receives
`SubError({code:"auth_timeout"})`.

## Connection lifecycle

- **One WS per client.** All `.watch()` subscriptions multiplex over a single
  socket. The socket opens lazily on the first `.watch()` and stays alive
  until explicitly closed.
- **Reconnect.** On unexpected disconnect, the client reconnects with
  exponential backoff: `1s, 2s, 4s, 8s, 16s, 30s, 30s, …` (jittered ±20%).
  On every (re)connect the SDK sends a fresh `connection_init` and re-issues
  every active table sub with fresh ids.
- **JWT refresh.** The current session's access token is read on every
  (re)connect attempt.
- **Heartbeat.** Native WebSocket ping/pong (browser / `ws` library handle
  these transparently).
- **Close.** Call `db.functions_closeReactive()` on app teardown to send
  `complete` for every live table sub and close the socket cleanly.

## Coalescing and dedup

- **Coalesce.** Bursts of CDC events on the same user-level sub collapse
  into at most one in-flight HTTP re-invoke per sub. While an invoke is
  running, additional events set a `pendingRerun` flag; a single trailing
  invoke runs once the current one completes.
- **Hash dedup.** Re-invoke results are SHA-256-hashed (stable JSON);
  `onUpdate` fires only when the hash differs from the last emitted value.
  Identical successive results are dropped.

## Known behavior

- **Auth switch (sign in / sign out) does not auto-reconnect.** The existing
  WS keeps its original JWT until it disconnects naturally (or you call
  `db.functions_closeReactive()`). To force a JWT swap immediately, close
  the reactive socket — the next `.watch()` opens a fresh one with the new
  token.
- **Browser bundler tree-shaking.** The `ws` Node peer dep is gated behind
  a late `require("ws")` so browser bundlers can drop it. In a browser, the
  SDK uses `globalThis.WebSocket`. In Node 22+ the built-in global is used;
  in Node 18–21 you need `ws` installed (declared as an optional peer dep).
- **Reads shift.** `reads` from a re-invoke is currently treated as a no-op
  if it differs from the initial list. Newly-introduced dependencies will
  miss invalidations until they appear on the original read set or the
  user resubscribes.

## Framework integration

React/Vue/Svelte hooks that wrap `.watch()` ship in a follow-up. The
primitives are stable; you can already write a 6-line hook:

```ts
import { useEffect, useState } from "react";

export function useQuery<T>(lazy: { watch(): Subscription<T> }): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    const sub = lazy.watch();
    sub.onUpdate(setData);
    return () => sub.close();
  }, [lazy]);
  return data;
}
```
