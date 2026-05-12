# Reactive queries — `db.functions.<m>.<n>().watch()`

Phase 9b.C added a `.watch()` API to `db.functions`. Every call still returns
a thenable for `await` (one-shot HTTP), and now also exposes `.watch()` to
subscribe to push updates over a WebSocket.

## Quick start

```ts
import { createClient } from "@excalibase/sdk";

const db = createClient({
  url: "http://localhost:10000",
  projectId: "acme/prod",
  publishableKey: "esk_pub_live_...",
  // NEW: required for `.watch()`. Omit it to disable reactive.
  wsUrl: "ws://localhost:10001/functions/v1/acme/prod/_watch",
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

`wsUrl` is the WS endpoint of the function runtime's reactive sibling port.
Format:

```
ws(s)://<host>:<wsPort>/functions/v1/{orgSlug}/{projectName}/_watch
```

When `wsUrl` is omitted, calling `.watch()` throws a clear error. `await`
calls still work without `wsUrl`.

## Wire protocol

The SDK speaks the `excalibase-fn-v1` subprotocol on the WebSocket. The JWT
is passed as a `?token=<jwt>` query parameter (browser `new WebSocket(...)`
cannot set HTTP headers, so query param is the only portable carrier).

Frames are JSON.

| Direction | Frame |
|-----------|-------|
| Client → Server | `{op:"subscribe",subId,ref:{moduleName,exportName},args}` |
| Client → Server | `{op:"unsubscribe",subId}` |
| Client → Server | `{op:"pong"}` |
| Server → Client | `{op:"result",subId,data,pageStatus?}` |
| Server → Client | `{op:"error",subId,code,message}` |
| Server → Client | `{op:"ping"}` |

The `pageStatus` field (`"SplitRecommended"` / `"SplitRequired"` / `null`) is
passed through to the subscription handler as part of `data`. The SDK does
not interpret it — surface it to your UI for pagination hints.

## Connection lifecycle

- **One WS per client.** All `.watch()` subscriptions on a `db` instance
  multiplex over a single socket. The socket opens lazily on the first
  `.watch()` and stays alive until explicitly closed.
- **Reconnect.** On unexpected disconnect, the client reconnects with
  exponential backoff: `1s, 2s, 4s, 8s, 16s, 30s, 30s, …` (jittered ±20%).
  All pending subscriptions are replayed on the new socket.
- **JWT refresh.** The current session's access token is read on every
  (re)connect attempt — so a refreshed JWT takes effect on next reconnect.
- **Server pings.** The server pings every 30 s; the SDK replies with pong.
  If the SDK doesn't pong in 90 s the server closes (code 1008). The SDK
  then reconnects per the backoff curve.
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
