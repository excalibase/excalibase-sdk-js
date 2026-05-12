# Reactive queries — `db.functions.<m>.<n>().watch()` + typed `api` graph

Phase 9b.C added a `.watch()` API to `db.functions`. Every call still returns
a thenable for `await` (one-shot HTTP), and now also exposes `.watch()` to
subscribe to push updates over a WebSocket.

Phase 7.1 added a parallel typed `api`/`internal` value graph emitted by
codegen alongside `functions.types.ts`. Pass a ref like `api.users.list` to
function runtime helpers (`ctx.runQuery`, `ctx.runMutation`) and TS infers
both `args` and the return type from the ref.

## Two paths, same metadata

| Path | Use case | Typed? |
|------|----------|--------|
| `db.functions.users.list(args)` | Client-side RPC over HTTP / WS | Yes (via `Functions` generic, Phase 2) |
| `ctx.runQuery(api.users.list, args)` | Function-to-function calls server-side | Yes (via `FunctionRef<Args, Result>`, Phase 7.1) |
| `ctx.runMutation(internal.admin.cleanup, args)` | Internal-only graph (never exposed to clients) | Yes (Phase 7.1) |

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

Generated `api.ts` shape:

```ts
import type { FunctionRef } from "@excalibase/sdk";

export interface Users_List_Args { status: string; limit?: number }
// ...

export const api = {
  users: {
    list: { moduleName: "users", exportName: "list", kind: "query" }
            as FunctionRef<Users_List_Args, unknown>,
    create: { moduleName: "users", exportName: "create", kind: "mutation" }
            as FunctionRef<Users_Create_Args, unknown>,
  },
} as const;

export const internal = {
  admin: {
    cleanup: { moduleName: "admin", exportName: "cleanup", kind: "internalMutation" }
              as FunctionRef<Admin_Cleanup_Args, unknown>,
  },
} as const;
```

Call sites:

```ts
// Server-side (inside a function body) — typed via FunctionRef.
const posts = await ctx.runQuery(api.users.list, { status: "active" });
await ctx.runMutation(internal.admin.cleanup, { olderThanDays: 30 });

// Client-side — Phase 2 surface still works.
const posts2 = await db.functions.users.list({ status: "active" });
```

`internal` separates exports tagged `internalQuery`/`internalMutation`/
`internalAction` from public ones. The SDK does not (and cannot) prevent a
caller from typing `internal.admin.cleanup` directly — the separation is a
discoverability + intent signal. The function runtime still enforces that
internal exports are not callable over the public HTTP surface.

> **Return-type inference (Phase 7.2)** — `TResult` is currently `unknown`.
> Once the bundler emits a return-shape JSON Schema alongside `argsJsonSchema`,
> codegen will swap `unknown` for the inferred type.

## Quick start

```ts
import { createClient } from "@excalibase/sdk";

const db = createClient({
  url: "http://localhost:10000",
  projectId: "acme/prod",
  publishableKey: "esk_pub_live_...",
  // NEW (Phase 15c): points at graphql's `/api/v1/realtime` WebSocket.
  // Multiplexed with collection-level CDC subscriptions over one socket.
  // Required for `.watch()`. Omit it to disable reactive.
  wsUrl: "ws://localhost:10000/api/v1/realtime",
});

// One-shot (unchanged from Phase 2)
const initial = await db.functions.posts.list({ status: "published" });

// Reactive
const sub = db.functions.posts.list({ status: "published" }).watch();
const unsub = sub.onUpdate((posts) => render(posts));
sub.onError((err) => console.error(err.code, err.message));

// Tear down
unsub();      // remove this listener
sub.close();  // close the subscription server-side
```

## API

### `LazyQuery<T>`

Returned from every `db.functions.<m>.<n>(args)` call.

- `await query` — one-shot HTTP POST (Phase 2 behavior, unchanged).
- `query.watch()` — open a reactive subscription. Returns a `Subscription<T>`.

### `Subscription<T>`

```ts
interface Subscription<T> {
  onUpdate(handler: (data: T) => void): () => void; // returns unsubscribe
  onError(handler: (err: SubError) => void): () => void;
  close(): void;
}

interface SubError {
  code: string;     // e.g. "permission_denied", "not_found", "validation"
  message: string;
}
```

### `createClient({ wsUrl })`

`wsUrl` is the WS endpoint of the graphql server's realtime handler — the
same path that already powers collection-level CDC subscriptions. Function
subscriptions multiplex on top of the same socket.

```
ws(s)://<graphql-host>/api/v1/realtime
```

When `wsUrl` is omitted, calling `.watch()` throws a clear error. `await`
calls still work without `wsUrl`.

## Wire protocol

The SDK opens a plain WebSocket to graphql's `/api/v1/realtime` endpoint (no
custom subprotocol). Authentication follows the GraphQL-WS convention used by
the collection-subscription protocol that already lives on the same endpoint.

### Auth handshake

1. Client opens the WebSocket.
2. Client sends:
   ```json
   {"type":"connection_init","payload":{"Authorization":"Bearer <jwt>"}}
   ```
3. Server replies:
   ```json
   {"type":"connection_ack"}
   ```
4. Once the ack lands, the client may send `subscribe-function` frames.
   If no ack arrives within 5 s (or the server closes mid-handshake) every
   pending sub receives `SubError({code:"auth_timeout"})`.

### Frames (post-ack)

Frames are JSON.

| Direction | Frame |
|-----------|-------|
| Client → Server | `{op:"subscribe-function",subId,projectId,ref:{moduleName,exportName},args}` |
| Client → Server | `{op:"unsubscribe-function",subId}` |
| Server → Client | `{op:"function-result",subId,data,pageStatus?}` |
| Server → Client | `{op:"function-error",subId,code,message}` |

The `pageStatus` field (`"SplitRecommended"` / `"SplitRequired"` / `null`) is
passed through to the subscription handler as part of `data`. The SDK does
not interpret it — surface it to your UI for pagination hints.

Server-emitted `code` values from graphql 15a: `bad_request`, `unauthenticated`,
`functions_disabled`, `invoke_failed_status_<N>`, `invoke_transport_error`.

## Connection lifecycle

- **One WS per client.** All `.watch()` subscriptions on a `db` instance
  multiplex over a single socket. The socket opens lazily on the first
  `.watch()` and stays alive until explicitly closed.
- **Reconnect.** On unexpected disconnect, the client reconnects with
  exponential backoff: `1s, 2s, 4s, 8s, 16s, 30s, 30s, …` (jittered ±20%).
  On every (re)connect the SDK sends a fresh `connection_init` and waits
  for `connection_ack` before replaying pending `subscribe-function` frames.
- **JWT refresh.** The current session's access token is read on every
  (re)connect attempt — so a refreshed JWT takes effect on next reconnect.
- **Heartbeat.** Native WebSocket ping/pong frames. The graphql server uses
  the built-in TCP-level ping/pong of the WebSocket protocol (browser and
  `ws` library handle these transparently); the SDK does not implement an
  application-level heartbeat.
- **Close.** Call `db.functions_closeReactive()` on app teardown to send
  unsubscribes for every live sub and close the socket cleanly.

## Known behavior

- **Auth switch (sign in / sign out) does not auto-reconnect.** The existing
  WS keeps its original JWT until it disconnects naturally (or you call
  `db.functions_closeReactive()`). To force a JWT swap immediately, close
  the reactive socket — the next `.watch()` opens a fresh one with the new
  token.
- **Browser bundler tree-shaking.** The `ws` Node peer dep is gated behind a
  late `require("ws")` so browser bundlers can drop it. In a browser, the
  SDK uses `globalThis.WebSocket`. In Node 22+ the built-in global is used;
  in Node 18–21 you need `ws` installed (declared as an optional peer dep).

## Framework integration (Phase 9b.E)

React/Vue/Svelte hooks that wrap `.watch()` ship in a follow-up phase. The
primitives in this phase are stable; you can already write a 6-line hook:

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
