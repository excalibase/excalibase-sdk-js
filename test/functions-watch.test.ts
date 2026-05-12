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

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from "@jest/globals";
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
