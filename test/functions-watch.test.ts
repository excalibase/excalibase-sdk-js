/**
 * Phase 9b.C: `.watch()` reactive subscriptions for `db.functions.<mod>.<exp>`.
 *
 * Wire shape (pinned by Phase 9b.A on the Deno side):
 *   - Subprotocol: `excalibase-fn-v1`
 *   - JWT: query param `?token=<jwt>` (browser `new WebSocket(...)` can't set headers)
 *   - URL:   ws(s)://<host>:<wsPort>/functions/v1/{projectId}/_watch?token=<jwt>
 *   - Inbound: {op:"subscribe",subId,ref:{moduleName,exportName},args}
 *              {op:"unsubscribe",subId}
 *              {op:"ping"}
 *   - Outbound:{op:"result",subId,data,pageStatus?}
 *              {op:"error",subId,code,message}
 *              {op:"pong"}
 *
 * These tests exercise the SDK side: that the Proxy returns a thenable
 * LazyQuery (await still works) AND a `.watch()` Subscription handle, that
 * the ReactiveWebSocket multiplexes subscriptions, reconnects with backoff,
 * resubscribes, surfaces pageStatus, and rejects when no wsUrl is configured.
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { WebSocketServer, WebSocket as WSWebSocket } from "ws";
import { createClient } from "../src";
import { memoryStorageAdapter } from "../src/storage";
import {
  ReactiveWebSocket,
  __setReconnectBackoff,
  __resetReconnectBackoff,
} from "../src/functions/reactive_ws";

/** Picks a free TCP port by binding to :0 with the WS server. */
function startMockWsServer(handler: (ws: WSWebSocket, url: string) => void): Promise<{
  url: string;
  close: () => Promise<void>;
  wss: WebSocketServer;
  connections: () => number;
  lastConnectionUrl: () => string | null;
}> {
  return new Promise((resolve) => {
    let connectionCount = 0;
    let lastUrl: string | null = null;
    const wss = new WebSocketServer({ port: 0, handleProtocols: () => "excalibase-fn-v1" });
    wss.on("listening", () => {
      const address = wss.address();
      if (address == null || typeof address === "string") {
        throw new Error("expected AddressInfo");
      }
      wss.on("connection", (ws, req) => {
        connectionCount += 1;
        lastUrl = req.url ?? "";
        handler(ws, lastUrl);
      });
      resolve({
        url: `ws://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((r) => {
            for (const client of wss.clients) {
              try {
                client.terminate();
              } catch {
                // ignore
              }
            }
            wss.close(() => r());
          }),
        wss,
        connections: () => connectionCount,
        lastConnectionUrl: () => lastUrl,
      });
    });
  });
}

/** Wait until the predicate is true, polling every 5ms, or fail. */
async function waitFor(pred: () => boolean, timeoutMs = 2000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

/** Flush microtasks + macrotasks so the openSocket promise chain settles. */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

const baseOpts = {
  url: "http://localhost:10000",
  projectId: "acme/prod",
  publishableKey: "esk_pub_live_abcdefghijklmnop",
  storage: memoryStorageAdapter(),
  autoRefreshToken: false,
};

beforeEach(() => {
  // Speed up reconnect to 5ms..50ms for tests (override module-internal curve).
  __setReconnectBackoff({ baseMs: 5, capMs: 50, jitter: 0 });
});

afterEach(() => {
  __resetReconnectBackoff();
});

describe("ReactiveWebSocket — low-level WS multiplexing client", () => {
  test("subscribe sends correct frame and dispatches result to onUpdate", async () => {
    const received: unknown[] = [];
    const sent: unknown[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        sent.push(msg);
        if (msg.op === "subscribe") {
          ws.send(
            JSON.stringify({ op: "result", subId: msg.subId, data: { hello: "world" } }),
          );
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/functions/v1/acme/prod/_watch`,
      jwtProvider: async () => "jwt-1",
    });
    const unsub = ws.subscribe(
      "sub-1",
      { moduleName: "users", exportName: "list" },
      { status: "active" },
      (data) => received.push(data),
      () => undefined,
    );
    await waitFor(() => received.length > 0, 2000, "result received");
    expect(received).toEqual([{ hello: "world" }]);
    expect(sent[0]).toEqual({
      op: "subscribe",
      subId: "sub-1",
      ref: { moduleName: "users", exportName: "list" },
      args: { status: "active" },
    });
    unsub();
    await ws.close();
    await server.close();
  });

  test("connection URL carries ?token=<jwt> query param", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: null }));
        }
      });
    });
    const got: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/functions/v1/acme/prod/_watch`,
      jwtProvider: async () => "tok-abc-123",
    });
    const unsub = ws.subscribe(
      "s",
      { moduleName: "m", exportName: "n" },
      {},
      (d) => got.push(d),
      () => undefined,
    );
    await waitFor(() => got.length > 0, 2000, "any frame");
    expect(server.lastConnectionUrl()).toContain("token=tok-abc-123");
    expect(server.lastConnectionUrl()).toContain("/functions/v1/acme/prod/_watch");
    unsub();
    await ws.close();
    await server.close();
  });

  test("multiplexes multiple subscriptions over one WS connection", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          ws.send(
            JSON.stringify({ op: "result", subId: msg.subId, data: { id: msg.subId } }),
          );
        }
      });
    });
    const aResults: unknown[] = [];
    const bResults: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/functions/v1/x/y/_watch`,
      jwtProvider: async () => "tk",
    });
    ws.subscribe("a", { moduleName: "m", exportName: "n" }, {}, (d) => aResults.push(d), () => undefined);
    ws.subscribe("b", { moduleName: "m", exportName: "n" }, {}, (d) => bResults.push(d), () => undefined);
    await waitFor(() => aResults.length > 0 && bResults.length > 0, 2000, "both subs got result");
    expect(server.connections()).toBe(1);
    expect(aResults[0]).toEqual({ id: "a" });
    expect(bResults[0]).toEqual({ id: "b" });
    await ws.close();
    await server.close();
  });

  test("server error frame routes to onError for that subId only", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe" && msg.subId === "bad") {
          ws.send(
            JSON.stringify({ op: "error", subId: "bad", code: "not_found", message: "no such fn" }),
          );
        } else if (msg.op === "subscribe") {
          ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: "ok" }));
        }
      });
    });
    const aErrors: Array<{ code: string; message: string }> = [];
    const bUpdates: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/_watch`,
      jwtProvider: async () => "t",
    });
    ws.subscribe("bad", { moduleName: "m", exportName: "missing" }, {}, () => undefined, (e) =>
      aErrors.push(e),
    );
    ws.subscribe("good", { moduleName: "m", exportName: "n" }, {}, (d) => bUpdates.push(d), () => undefined);
    await waitFor(() => aErrors.length > 0 && bUpdates.length > 0, 2000, "error + result");
    expect(aErrors[0].code).toBe("not_found");
    expect(aErrors[0].message).toBe("no such fn");
    expect(bUpdates[0]).toBe("ok");
    await ws.close();
    await server.close();
  });

  test("client replies pong when server sends ping", async () => {
    const pongs: unknown[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "pong") pongs.push(msg);
      });
      // ping after the first subscribe to make sure the client is ready.
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: 1 }));
          ws.send(JSON.stringify({ op: "ping" }));
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/_watch`,
      jwtProvider: async () => "t",
    });
    const got: unknown[] = [];
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => pongs.length > 0, 2000, "server saw pong");
    expect(pongs[0]).toEqual({ op: "pong" });
    await ws.close();
    await server.close();
  });

  test("on disconnect, reconnects with backoff and resubscribes pending subs", async () => {
    let connectionNum = 0;
    const subscribeFramesByConn: Record<number, unknown[]> = {};
    const server = await startMockWsServer((ws) => {
      connectionNum += 1;
      const localConn = connectionNum;
      subscribeFramesByConn[localConn] = [];
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          subscribeFramesByConn[localConn]!.push(msg);
          ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: { c: localConn } }));
          if (localConn === 1) {
            // Force a disconnect AFTER acking the subscribe.
            setTimeout(() => ws.terminate(), 10);
          }
        }
      });
    });
    const updates: unknown[] = [];
    const errors: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/_watch`,
      jwtProvider: async () => "t",
    });
    ws.subscribe("s1", { moduleName: "m", exportName: "n" }, { p: 1 }, (d) => updates.push(d), (e) =>
      errors.push(e),
    );
    await waitFor(() => server.connections() >= 2, 5000, "second connection after reconnect");
    await waitFor(
      () => (subscribeFramesByConn[2]?.length ?? 0) > 0,
      5000,
      "resubscribe on second connection",
    );
    // Frame on conn 2 must equal the original ref/args (re-issued from pending).
    expect(subscribeFramesByConn[2]![0]).toMatchObject({
      op: "subscribe",
      subId: "s1",
      ref: { moduleName: "m", exportName: "n" },
      args: { p: 1 },
    });
    await ws.close();
    await server.close();
  });

  test("close() sends unsubscribe for active subs and closes the socket", async () => {
    const sentMessages: unknown[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        sentMessages.push(msg);
        if (msg.op === "subscribe") {
          ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: 1 }));
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/_watch`,
      jwtProvider: async () => "t",
    });
    const updates: unknown[] = [];
    ws.subscribe("s1", { moduleName: "m", exportName: "n" }, {}, (d) => updates.push(d), () => undefined);
    await waitFor(() => updates.length > 0, 2000, "got result");
    await ws.close();
    await waitFor(
      () => sentMessages.some((m) => (m as { op?: string }).op === "unsubscribe"),
      2000,
      "saw unsubscribe frame",
    );
    const unsubFrame = sentMessages.find((m) => (m as { op?: string }).op === "unsubscribe");
    expect(unsubFrame).toEqual({ op: "unsubscribe", subId: "s1" });
    await server.close();
  });

  test("unsubscribe handle stops further dispatches and sends unsubscribe frame", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: 1 }));
          // Push a second update later to verify the unsub gate blocked it.
          setTimeout(() => {
            try {
              ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: 2 }));
            } catch {
              // ignore
            }
          }, 30);
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/_watch`,
      jwtProvider: async () => "t",
    });
    const updates: unknown[] = [];
    const unsub = ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => updates.push(d), () => undefined);
    await waitFor(() => updates.length > 0, 2000, "first update");
    unsub();
    await new Promise((r) => setTimeout(r, 80));
    expect(updates).toEqual([1]);
    await ws.close();
    await server.close();
  });
});

describe("LazyQuery — db.functions.<m>.<n>(args) thenable + .watch()", () => {
  test("await still resolves via HTTP POST (backwards-compat with Phase 2)", async () => {
    let captured: { url: string; body: unknown } | null = null;
    const mockFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
      captured = {
        url: url as string,
        body: init?.body ? JSON.parse(init.body as string) : null,
      };
      return new Response(JSON.stringify({ data: { total: 9 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const db = createClient({ ...baseOpts, fetch: mockFetch });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fns = db.functions as any;
    const result = await fns.users.list({ status: "active" });
    expect(result).toEqual({ total: 9 });
    expect(captured!.url).toBe("http://localhost:10000/functions/v1/acme/prod/users.list");
    expect(captured!.body).toEqual({ args: { status: "active" } });
  });

  test(".watch() without wsUrl configured throws a clear error", () => {
    const db = createClient({ ...baseOpts });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lazy = (db.functions as any).users.list({});
    expect(typeof lazy.watch).toBe("function");
    expect(() => lazy.watch()).toThrow(/wsUrl/);
  });

  test(".watch() returns a Subscription that delivers updates via the WS", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          ws.send(
            JSON.stringify({
              op: "result",
              subId: msg.subId,
              data: [{ id: 1 }, { id: 2 }],
              pageStatus: "SplitRecommended",
            }),
          );
        }
      });
    });
    const db = createClient({ ...baseOpts, wsUrl: `${server.url}/functions/v1/acme/prod/_watch` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lazy = (db.functions as any).users.list({ q: "x" });
    const sub = lazy.watch();
    const received: unknown[] = [];
    const errors: unknown[] = [];
    sub.onUpdate((d: unknown) => received.push(d));
    sub.onError((e: unknown) => errors.push(e));
    await waitFor(() => received.length > 0, 2000, "received update");
    // pageStatus is passed through on the data envelope, NOT interpreted.
    expect(received[0]).toEqual([{ id: 1 }, { id: 2 }]);
    expect(errors).toEqual([]);
    sub.close();
    await db.functions_closeReactive();
    await server.close();
  });

  test(".watch() onUpdate handler returns unsubscribe that stops further updates", async () => {
    let serverConn: WSWebSocket | null = null;
    let lastSubId: string | null = null;
    const server = await startMockWsServer((ws) => {
      serverConn = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          lastSubId = msg.subId;
          ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: { v: 1 } }));
        }
      });
    });
    const db = createClient({ ...baseOpts, wsUrl: `${server.url}/_watch` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = (db.functions as any).users.list({}).watch();
    const got: unknown[] = [];
    const off = sub.onUpdate((d: unknown) => got.push(d));
    await waitFor(() => got.length > 0, 2000, "update");
    off();
    if (serverConn != null && lastSubId != null) {
      (serverConn as WSWebSocket).send(JSON.stringify({ op: "result", subId: lastSubId, data: { v: 2 } }));
    }
    await new Promise((r) => setTimeout(r, 40));
    expect(got).toEqual([{ v: 1 }]);
    sub.close();
    await db.functions_closeReactive();
    await server.close();
  });

  test("pageStatus passthrough — result envelope object contains pageStatus when wrapped", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          ws.send(
            JSON.stringify({
              op: "result",
              subId: msg.subId,
              data: { items: [], pageStatus: "SplitRequired" },
              pageStatus: "SplitRequired",
            }),
          );
        }
      });
    });
    const db = createClient({ ...baseOpts, wsUrl: `${server.url}/_watch` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = (db.functions as any).posts.list({}).watch();
    const updates: Array<{ items: unknown[]; pageStatus?: string }> = [];
    sub.onUpdate((d: { items: unknown[]; pageStatus?: string }) => updates.push(d));
    await waitFor(() => updates.length > 0, 2000, "update");
    expect(updates[0].pageStatus).toBe("SplitRequired");
    sub.close();
    await db.functions_closeReactive();
    await server.close();
  });

  test("single WS multiplexed across multiple .watch() calls on one client", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: msg.subId }));
        }
      });
    });
    const db = createClient({ ...baseOpts, wsUrl: `${server.url}/_watch` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fns = db.functions as any;
    const subA = fns.users.list({}).watch();
    const subB = fns.posts.list({}).watch();
    const a: unknown[] = [];
    const b: unknown[] = [];
    subA.onUpdate((d: unknown) => a.push(d));
    subB.onUpdate((d: unknown) => b.push(d));
    await waitFor(() => a.length > 0 && b.length > 0, 2000, "both");
    expect(server.connections()).toBe(1);
    subA.close();
    subB.close();
    await db.functions_closeReactive();
    await server.close();
  });

  test("server-side onError frame is dispatched to .watch().onError handler", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          ws.send(
            JSON.stringify({
              op: "error",
              subId: msg.subId,
              code: "permission_denied",
              message: "row-level security blocked this query",
            }),
          );
        }
      });
    });
    const db = createClient({ ...baseOpts, wsUrl: `${server.url}/_watch` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = (db.functions as any).admin.listUsers({}).watch();
    const errs: Array<{ code: string; message: string }> = [];
    sub.onError((e: { code: string; message: string }) => errs.push(e));
    await waitFor(() => errs.length > 0, 2000, "error frame");
    expect(errs[0].code).toBe("permission_denied");
    expect(errs[0].message).toMatch(/row-level security/);
    sub.close();
    await db.functions_closeReactive();
    await server.close();
  });
});

describe("ReactiveWebSocket — coverage edges", () => {
  test("WebSocket constructor explicitly overridable via websocketImpl", async () => {
    const sent: unknown[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        sent.push(msg);
        if (msg.op === "subscribe") {
          ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: "x" }));
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/_watch`,
      jwtProvider: () => "sync-tok", // non-async path
      websocketImpl: WSWebSocket as unknown as new (
        url: string,
        protocols?: string | string[],
      ) => unknown,
      log: () => undefined,
    });
    const got: unknown[] = [];
    ws.subscribe("e", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length > 0, 2000, "result");
    expect(got[0]).toBe("x");
    await ws.close();
    await server.close();
  });

  test("token query param uses ? when url has no existing query, & when it does", async () => {
    // We can't mount WS at a path with `?` reliably in mock server, so just
    // hit appendTokenQuery via the connection URL on conn.
    const captured: string[] = [];
    const server = await startMockWsServer((ws, url) => {
      captured.push(url);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: 1 }));
      });
    });
    const a = new ReactiveWebSocket({ url: `${server.url}/p`, jwtProvider: () => "tk" });
    const done: unknown[] = [];
    a.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => done.push(d), () => undefined);
    await waitFor(() => done.length > 0, 2000, "first connect");
    await a.close();
    const b = new ReactiveWebSocket({ url: `${server.url}/p?x=1`, jwtProvider: () => "tk" });
    const done2: unknown[] = [];
    b.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => done2.push(d), () => undefined);
    await waitFor(() => done2.length > 0, 2000, "second connect");
    expect(captured[0]).toMatch(/\/p\?token=tk$/);
    expect(captured[1]).toMatch(/\/p\?x=1&token=tk$/);
    await b.close();
    await server.close();
  });

  test("empty JWT does not append token query param", async () => {
    const captured: string[] = [];
    const server = await startMockWsServer((ws, url) => {
      captured.push(url);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: 1 }));
      });
    });
    const ws = new ReactiveWebSocket({ url: `${server.url}/p`, jwtProvider: () => "" });
    const got: unknown[] = [];
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length > 0, 2000, "result");
    expect(captured[0]).not.toContain("token=");
    await ws.close();
    await server.close();
  });

  test("jwtProvider throwing → log + reconnect still attempted with empty token", async () => {
    const captured: string[] = [];
    const server = await startMockWsServer((ws, url) => {
      captured.push(url);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: 1 }));
      });
    });
    const logs: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/p`,
      jwtProvider: async () => {
        throw new Error("no-token");
      },
      log: (...args) => logs.push(args),
    });
    const got: unknown[] = [];
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length > 0, 2000, "result");
    expect(logs.length).toBeGreaterThan(0);
    expect(captured[0]).not.toContain("token=");
    await ws.close();
    await server.close();
  });

  test("subscribe after close throws", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", () => undefined);
    });
    const ws = new ReactiveWebSocket({ url: `${server.url}/p`, jwtProvider: () => "t" });
    await ws.close();
    expect(() =>
      ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined),
    ).toThrow(/closed/);
    await server.close();
  });

  test("server frame with unknown op is ignored (no crash)", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          ws.send(JSON.stringify({ op: "unknown_op", subId: msg.subId }));
          ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: 99 }));
        }
      });
    });
    const ws = new ReactiveWebSocket({ url: `${server.url}/p`, jwtProvider: () => "t" });
    const got: unknown[] = [];
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length > 0, 2000, "result");
    expect(got).toEqual([99]);
    await ws.close();
    await server.close();
  });

  test("non-JSON server frame ignored", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          ws.send("not-json");
          ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: "ok" }));
        }
      });
    });
    const logs: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/p`,
      jwtProvider: () => "t",
      log: (...args) => logs.push(args),
    });
    const got: unknown[] = [];
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length > 0, 2000, "result");
    expect(got).toEqual(["ok"]);
    expect(logs.some((args) => String((args as unknown[])[0]).includes("non-JSON"))).toBe(true);
    await ws.close();
    await server.close();
  });

  test("result frame for missing/stale subId is silently dropped", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          // Ack the real sub.
          ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: 1 }));
          // And a stale frame for a nonexistent sub.
          ws.send(JSON.stringify({ op: "result", subId: "ghost", data: 999 }));
          ws.send(JSON.stringify({ op: "error", subId: "ghost", code: "x", message: "y" }));
          // result with no subId
          ws.send(JSON.stringify({ op: "result" }));
        }
      });
    });
    const ws = new ReactiveWebSocket({ url: `${server.url}/p`, jwtProvider: () => "t" });
    const got: unknown[] = [];
    const errs: unknown[] = [];
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), (e) => errs.push(e));
    await new Promise((r) => setTimeout(r, 80));
    expect(got).toEqual([1]);
    expect(errs).toEqual([]);
    await ws.close();
    await server.close();
  });

  test("error frame without code/message falls back to default values", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          ws.send(JSON.stringify({ op: "error", subId: msg.subId }));
        }
      });
    });
    const ws = new ReactiveWebSocket({ url: `${server.url}/p`, jwtProvider: () => "t" });
    const errs: Array<{ code: string; message: string }> = [];
    ws.subscribe(
      "s",
      { moduleName: "m", exportName: "n" },
      {},
      () => undefined,
      (e) => errs.push(e),
    );
    await waitFor(() => errs.length > 0, 2000, "error");
    expect(errs[0].code).toBe("subscription_error");
    expect(errs[0].message).toBe("subscription error");
    await ws.close();
    await server.close();
  });

  test("WS constructor throwing → schedules reconnect (no crash)", async () => {
    const logs: unknown[] = [];
    let calls = 0;
    const ThrowingCtor = function () {
      calls += 1;
      throw new Error("connect blew up");
    } as unknown as new (url: string, protocols?: string | string[]) => unknown;
    const ws = new ReactiveWebSocket({
      url: "ws://127.0.0.1:1/p",
      jwtProvider: () => "t",
      websocketImpl: ThrowingCtor,
      log: (...args) => logs.push(args),
    });
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await new Promise((r) => setTimeout(r, 80));
    // First call + at least one reconnect attempt.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(logs.some((args) => String((args as unknown[])[0]).includes("WS constructor"))).toBe(true);
    await ws.close();
  });

  test("unsubscribe is idempotent and frees the map slot", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: 1 }));
        }
      });
    });
    const ws = new ReactiveWebSocket({ url: `${server.url}/p`, jwtProvider: () => "t" });
    const got: unknown[] = [];
    const unsub = ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length > 0, 2000, "first");
    expect(ws.size()).toBe(1);
    unsub();
    unsub(); // idempotent — no throw
    expect(ws.size()).toBe(0);
    await ws.close();
    await server.close();
  });

  test("close() with no subs and no socket is a no-op", async () => {
    const ws = new ReactiveWebSocket({ url: "ws://127.0.0.1:1/p", jwtProvider: () => "t" });
    await ws.close();
    expect(ws.size()).toBe(0);
  });

  test("disconnect with no live subs does NOT reconnect", async () => {
    let connectionNum = 0;
    const server = await startMockWsServer((ws) => {
      connectionNum += 1;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe") {
          ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: 1 }));
        }
      });
    });
    const ws = new ReactiveWebSocket({ url: `${server.url}/p`, jwtProvider: () => "t" });
    const got: unknown[] = [];
    const unsub = ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length > 0, 2000, "ack");
    unsub();
    // Force the server side to terminate; client has no live subs → no reconnect.
    for (const client of server.wss.clients) client.terminate();
    await new Promise((r) => setTimeout(r, 80));
    expect(connectionNum).toBe(1);
    await ws.close();
    await server.close();
  });

  test("resolveWebSocketCtor uses globalThis.WebSocket when present", async () => {
    // Cover the browser-style branch without polluting globals permanently.
    const prev = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = WSWebSocket;
    try {
      const server = await startMockWsServer((ws) => {
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.op === "subscribe") ws.send(JSON.stringify({ op: "result", subId: msg.subId, data: 1 }));
        });
      });
      const ws = new ReactiveWebSocket({ url: `${server.url}/p`, jwtProvider: () => "t" });
      const got: unknown[] = [];
      ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
      await waitFor(() => got.length > 0, 2000, "result");
      await ws.close();
      await server.close();
    } finally {
      if (prev === undefined) {
        delete (globalThis as { WebSocket?: unknown }).WebSocket;
      } else {
        (globalThis as { WebSocket?: unknown }).WebSocket = prev;
      }
    }
  });
});

describe("ReactiveWebSocket — internal-path coverage with stub ctor", () => {
  /**
   * Build a stub WebSocket constructor that exposes the underlying instance
   * so tests can drive open/message/close/error and assert sends.
   */
  type StubListener = (ev: unknown) => void;
  interface StubSocket {
    url: string;
    protocols?: string | string[];
    readyState: number;
    sends: string[];
    listeners: Record<string, StubListener[]>;
    sendThrows: boolean;
    send(d: string): void;
    close(): void;
    on(event: string, listener: StubListener): void;
    off?(event: string, listener: StubListener): void;
    _emit(event: string, ev?: unknown): void;
  }
  function makeStubCtor() {
    const instances: StubSocket[] = [];
    const Ctor = function (this: unknown, url: string, protocols?: string | string[]) {
      const inst: StubSocket = {
        url,
        protocols,
        readyState: 0,
        sends: [],
        listeners: {},
        sendThrows: false,
        send(d: string) {
          if (inst.sendThrows) throw new Error("send blew up");
          inst.sends.push(d);
        },
        close() {
          inst.readyState = 3;
        },
        on(event: string, listener: StubListener) {
          (inst.listeners[event] ??= []).push(listener);
        },
        off(event: string, listener: StubListener) {
          const arr = inst.listeners[event];
          if (arr == null) return;
          const idx = arr.indexOf(listener);
          if (idx >= 0) arr.splice(idx, 1);
        },
        _emit(event: string, ev?: unknown) {
          for (const l of inst.listeners[event] ?? []) l(ev);
        },
      };
      instances.push(inst);
      return inst;
    } as unknown as new (url: string, protocols?: string | string[]) => unknown;
    return { Ctor, instances };
  }

  test("readyState===1 fast path: 2nd subscribe is sent over existing socket", async () => {
    const { Ctor, instances } = makeStubCtor();
    const ws = new ReactiveWebSocket({
      url: "ws://h/p",
      jwtProvider: () => "t",
      websocketImpl: Ctor,
    });
    ws.subscribe("a", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await flush();
    // Simulate open. After open, sock.readyState===1 and pending sub frame is replayed.
    expect(instances.length).toBe(1);
    instances[0]!.readyState = 1;
    instances[0]!._emit("open");
    expect(instances[0]!.sends.length).toBe(1);
    // 2nd sub should take the fast path: socket exists, readyState===1.
    ws.subscribe("b", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    expect(instances[0]!.sends.length).toBe(2);
    await ws.close();
  });

  test("error event handler is wired and logs without crashing", async () => {
    const { Ctor, instances } = makeStubCtor();
    const logs: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: "ws://h/p",
      jwtProvider: () => "t",
      websocketImpl: Ctor,
      log: (...args) => logs.push(args),
    });
    ws.subscribe("a", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await flush();
    instances[0]!.readyState = 1;
    instances[0]!._emit("open");
    instances[0]!._emit("error", new Error("oops"));
    expect(logs.some((args) => String((args as unknown[])[0]).includes("ws error"))).toBe(true);
    await ws.close();
  });

  test("safeSend swallows send() throws and logs", async () => {
    const { Ctor, instances } = makeStubCtor();
    const logs: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: "ws://h/p",
      jwtProvider: () => "t",
      websocketImpl: Ctor,
      log: (...args) => logs.push(args),
    });
    ws.subscribe("a", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await flush();
    instances[0]!.readyState = 1;
    instances[0]!.sendThrows = true;
    instances[0]!._emit("open"); // triggers sendSubscribe → safeSend → throws
    expect(logs.some((args) => String((args as unknown[])[0]).includes("ws send failed"))).toBe(true);
    await ws.close();
  });

  test("safeSend with not-yet-open socket is a no-op (no throw)", async () => {
    const { Ctor, instances } = makeStubCtor();
    const ws = new ReactiveWebSocket({
      url: "ws://h/p",
      jwtProvider: () => "t",
      websocketImpl: Ctor,
    });
    ws.subscribe("a", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await flush();
    // Don't emit 'open'. The pending subscribe is buffered. Now also call close()
    // which sends unsubscribes via safeSend — readyState===0 makes it a no-op.
    expect(instances[0]!.sends.length).toBe(0);
    await ws.close();
    expect(instances[0]!.sends.length).toBe(0);
  });

  test("addEventListener fallback path is used when on() is absent", async () => {
    type Listener = (ev: unknown) => void;
    const sends: string[] = [];
    let openListener: Listener | null = null;
    let messageListener: Listener | null = null;
    interface StubInst {
      readyState: number;
      send(d: string): void;
      close(): void;
      addEventListener(event: string, listener: Listener): void;
    }
    const Ctor = function () {
      const inst: StubInst = {
        readyState: 0,
        send(d: string) {
          sends.push(d);
        },
        close() {
          inst.readyState = 3;
        },
        addEventListener(event: string, listener: Listener) {
          if (event === "open") openListener = listener;
          if (event === "message") messageListener = listener;
        },
      };
      return inst;
    } as unknown as new () => unknown;
    const ws = new ReactiveWebSocket({
      url: "ws://h/p",
      jwtProvider: () => "t",
      websocketImpl: Ctor,
    });
    const updates: unknown[] = [];
    ws.subscribe("a", { moduleName: "m", exportName: "n" }, {}, (d) => updates.push(d), () => undefined);
    await flush();
    expect(openListener).not.toBeNull();
    expect(messageListener).not.toBeNull();
    // Emit the message; even without 'open' firing readyState, handleMessage()
    // unconditionally dispatches result/error frames to the registered subs.
    (messageListener as unknown as (ev: unknown) => void)({
      data: JSON.stringify({ op: "result", subId: "a", data: { ok: 1 } }),
    });
    expect(updates).toEqual([{ ok: 1 }]);
    await ws.close();
  });

  test("listener attach throws when neither on() nor addEventListener present", async () => {
    const Ctor = function () {
      return { readyState: 0, send: () => undefined, close: () => undefined };
    } as unknown as new () => unknown;
    const ws = new ReactiveWebSocket({
      url: "ws://h/p",
      jwtProvider: () => "t",
      websocketImpl: Ctor,
    });
    // The throw happens inside openSocket → attachListener (async). Subscribe
    // itself returns synchronously and never throws — the async openSocket
    // surfaces the error via the unhandled-rejection channel. To keep Jest
    // from treating that as a failure we install a temporary handler.
    const origListener = (process as { listeners: (e: string) => unknown[] }).listeners(
      "unhandledRejection",
    );
    const tmp = (): void => undefined;
    process.on("unhandledRejection", tmp);
    try {
      expect(() =>
        ws.subscribe("a", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined),
      ).not.toThrow();
      await flush();
    } finally {
      process.off("unhandledRejection", tmp);
      void origListener; // keep ref alive
    }
    await ws.close();
  });

  test("ws module resolver caches Node ctor after first use", async () => {
    // Force the cached path: import twice; first call should populate cache,
    // second should reuse it. We can't directly observe the cache, but we can
    // confirm at least one ReactiveWebSocket without an explicit ctor works.
    const server = await startMockWsServer((wsConn) => {
      wsConn.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe")
          wsConn.send(JSON.stringify({ op: "result", subId: msg.subId, data: 1 }));
      });
    });
    const a = new ReactiveWebSocket({ url: `${server.url}/p`, jwtProvider: () => "t" });
    const b = new ReactiveWebSocket({ url: `${server.url}/p`, jwtProvider: () => "t" });
    const got: unknown[] = [];
    a.subscribe("s1", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    b.subscribe("s2", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length === 2, 2000, "two clients");
    await a.close();
    await b.close();
    await server.close();
  });
});

describe("Reactive helpers — unit", () => {
  test("extractMessageData: string passthrough", async () => {
    const { __extractMessageDataForTest } = await import("../src/functions/reactive_ws");
    expect(__extractMessageDataForTest("hello")).toBe("hello");
  });
  test("extractMessageData: null/undefined → null", async () => {
    const { __extractMessageDataForTest } = await import("../src/functions/reactive_ws");
    expect(__extractMessageDataForTest(null)).toBeNull();
    expect(__extractMessageDataForTest(undefined)).toBeNull();
  });
  test("extractMessageData: MessageEvent.data string", async () => {
    const { __extractMessageDataForTest } = await import("../src/functions/reactive_ws");
    expect(__extractMessageDataForTest({ data: "x" })).toBe("x");
  });
  test("extractMessageData: MessageEvent.data ArrayBuffer", async () => {
    const { __extractMessageDataForTest } = await import("../src/functions/reactive_ws");
    const buf = new TextEncoder().encode("abc").buffer;
    expect(__extractMessageDataForTest({ data: buf })).toBe("abc");
  });
  test("extractMessageData: MessageEvent.data Buffer", async () => {
    const { __extractMessageDataForTest } = await import("../src/functions/reactive_ws");
    expect(__extractMessageDataForTest({ data: Buffer.from("xyz", "utf8") })).toBe("xyz");
  });
  test("extractMessageData: MessageEvent.data with unknown type → null", async () => {
    const { __extractMessageDataForTest } = await import("../src/functions/reactive_ws");
    expect(__extractMessageDataForTest({ data: 42 })).toBeNull();
  });
  test("extractMessageData: raw Node Buffer", async () => {
    const { __extractMessageDataForTest } = await import("../src/functions/reactive_ws");
    expect(__extractMessageDataForTest(Buffer.from("raw", "utf8"))).toBe("raw");
  });
  test("appendTokenQuery: empty token leaves url alone", async () => {
    const { __appendTokenQueryForTest } = await import("../src/functions/reactive_ws");
    expect(__appendTokenQueryForTest("ws://h/p", "")).toBe("ws://h/p");
  });
  test("appendTokenQuery: with ? when no query", async () => {
    const { __appendTokenQueryForTest } = await import("../src/functions/reactive_ws");
    expect(__appendTokenQueryForTest("ws://h/p", "abc")).toBe("ws://h/p?token=abc");
  });
  test("appendTokenQuery: with & when query present", async () => {
    const { __appendTokenQueryForTest } = await import("../src/functions/reactive_ws");
    expect(__appendTokenQueryForTest("ws://h/p?x=1", "abc")).toBe("ws://h/p?x=1&token=abc");
  });
  test("appendTokenQuery: URL-encodes token with special chars", async () => {
    const { __appendTokenQueryForTest } = await import("../src/functions/reactive_ws");
    expect(__appendTokenQueryForTest("ws://h/p", "a b+c")).toBe("ws://h/p?token=a%20b%2Bc");
  });
  test("computeBackoffDelayForTest with jitter > 0 produces value in [min,max]", async () => {
    __resetReconnectBackoff();
    const { computeBackoffDelayForTest } = await import("../src/functions/reactive_ws");
    for (let i = 0; i < 20; i++) {
      const v = computeBackoffDelayForTest(0, 0.5);
      // base 1000, jitter 0.5 → range [500, 1000]
      expect(v).toBeGreaterThanOrEqual(500);
      expect(v).toBeLessThanOrEqual(1000);
    }
  });
});

describe("Backoff curve", () => {
  test("first 5 reconnect delays follow exponential 1s→30s cap", async () => {
    // Reset to production curve for this assertion only.
    __resetReconnectBackoff();
    const { computeBackoffDelayForTest } = await import("../src/functions/reactive_ws");
    const noJitter = (n: number) => computeBackoffDelayForTest(n, 0);
    expect(noJitter(0)).toBe(1000);
    expect(noJitter(1)).toBe(2000);
    expect(noJitter(2)).toBe(4000);
    expect(noJitter(3)).toBe(8000);
    expect(noJitter(4)).toBe(16000);
    expect(noJitter(5)).toBe(30000); // capped
    expect(noJitter(99)).toBe(30000); // still capped
  });
});
