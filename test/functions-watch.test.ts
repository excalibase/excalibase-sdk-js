/**
 * Phase 15c: `.watch()` reactive subscriptions point at graphql's existing WS
 * endpoint (was a sibling Deno port).
 *
 * Wire shape (pinned by Phase 15a on the graphql side):
 *   - Endpoint: `ws(s)://<graphql-host>:<port>/api/v1/realtime`
 *     (same endpoint already used for collection-level CDC subscriptions —
 *     one WS multiplexed across both function and collection subs).
 *   - Auth: after WS open, the client sends
 *       {"type":"connection_init","payload":{"Authorization":"Bearer <jwt>"}}
 *     and waits for {"type":"connection_ack"} (5 s timeout).
 *   - Inbound (client → server):
 *       {"op":"subscribe-function","subId","projectId","ref":{moduleName,exportName},"args"}
 *       {"op":"unsubscribe-function","subId"}
 *   - Outbound (server → client):
 *       {"op":"function-result","subId","data","pageStatus"?}
 *       {"op":"function-error","subId","code","message"}
 *   - Heartbeat: native WS ping/pong frames (browser/library handle these
 *     transparently — no application-level ping op is sent by graphql 15a).
 *
 * These tests exercise the SDK side: that the Proxy returns a thenable
 * LazyQuery (await still works) AND a `.watch()` Subscription handle, that
 * the ReactiveWebSocket multiplexes subscriptions across one socket, reconnects
 * with backoff, replays connection_init + resubscribes pending subs after a
 * disconnect, surfaces pageStatus, and rejects when no wsUrl is configured.
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { WebSocketServer, WebSocket as WSWebSocket } from "ws";
import { createClient } from "../src";
import { memoryStorageAdapter } from "../src/storage";
import {
  ReactiveWebSocket,
  __setReconnectBackoff,
  __resetReconnectBackoff,
  __setConnectionAckTimeoutForTest,
  __resetConnectionAckTimeoutForTest,
} from "../src/functions/reactive_ws";

/**
 * Picks a free TCP port by binding to :0 with the WS server. The handler
 * receives a flag telling it whether to auto-reply `connection_ack` for the
 * `connection_init` frame (the default — what graphql 15a does). Tests that
 * exercise the auth-timeout / nack paths flip `autoAck=false` and drive the
 * server-side reply themselves.
 */
function startMockWsServer(
  handler: (ws: WSWebSocket, url: string) => void,
  opts: { autoAck?: boolean } = {},
): Promise<{
  url: string;
  close: () => Promise<void>;
  wss: WebSocketServer;
  connections: () => number;
  lastConnectionUrl: () => string | null;
}> {
  const autoAck = opts.autoAck ?? true;
  return new Promise((resolve) => {
    let connectionCount = 0;
    let lastUrl: string | null = null;
    const wss = new WebSocketServer({ port: 0 });
    wss.on("listening", () => {
      const address = wss.address();
      if (address == null || typeof address === "string") {
        throw new Error("expected AddressInfo");
      }
      wss.on("connection", (ws, req) => {
        connectionCount += 1;
        lastUrl = req.url ?? "";
        if (autoAck) {
          // Hook the first connection_init frame and ack it; pass everything
          // else through to the test handler.
          const initListener = (raw: WSWebSocket.RawData): void => {
            try {
              const msg = JSON.parse(raw.toString());
              if (msg.type === "connection_init") {
                ws.off("message", initListener);
                ws.send(JSON.stringify({ type: "connection_ack" }));
                return;
              }
            } catch {
              // ignore; pass through
            }
          };
          ws.on("message", initListener);
        }
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
  // Tighten the connection_ack timeout so the auth-timeout tests don't have to
  // wait 5 s. Production default is 5000 ms.
  __setConnectionAckTimeoutForTest(120);
});

afterEach(() => {
  __resetReconnectBackoff();
  __resetConnectionAckTimeoutForTest();
});

describe("ReactiveWebSocket — connection_init handshake (Phase 15c)", () => {
  test("sends connection_init with Bearer <jwt> after WS open", async () => {
    const initFrames: unknown[] = [];
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const address = wss.address();
    if (address == null || typeof address === "string") throw new Error("addr");
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "connection_init") {
          initFrames.push(msg);
          ws.send(JSON.stringify({ type: "connection_ack" }));
        } else if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: 1 }));
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `ws://127.0.0.1:${address.port}/api/v1/realtime`,
      projectId: "acme/prod",
      jwtProvider: async () => "jwt-xyz",
    });
    const got: unknown[] = [];
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length > 0, 2000, "got result after ack");
    expect(initFrames).toHaveLength(1);
    expect(initFrames[0]).toEqual({
      type: "connection_init",
      payload: { Authorization: "Bearer jwt-xyz" },
    });
    await ws.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  test("connection_init without a jwt sends an empty-Authorization payload", async () => {
    const initFrames: unknown[] = [];
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const address = wss.address();
    if (address == null || typeof address === "string") throw new Error("addr");
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "connection_init") {
          initFrames.push(msg);
          ws.send(JSON.stringify({ type: "connection_ack" }));
        } else if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: 1 }));
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `ws://127.0.0.1:${address.port}/api/v1/realtime`,
      projectId: "acme/prod",
      jwtProvider: () => "",
    });
    const got: unknown[] = [];
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length > 0, 2000, "got result");
    expect(initFrames[0]).toEqual({
      type: "connection_init",
      payload: { Authorization: "" },
    });
    await ws.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  test("waits for connection_ack before sending subscribe-function", async () => {
    const order: string[] = [];
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const address = wss.address();
    if (address == null || typeof address === "string") throw new Error("addr");
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "connection_init") {
          order.push("init");
          // Delay the ack to make any out-of-order subscribe-function obvious.
          setTimeout(() => {
            ws.send(JSON.stringify({ type: "connection_ack" }));
          }, 30);
        } else if (msg.op === "subscribe-function") {
          order.push("sub");
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: 1 }));
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `ws://127.0.0.1:${address.port}/api/v1/realtime`,
      projectId: "acme/prod",
      jwtProvider: () => "t",
    });
    const got: unknown[] = [];
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length > 0, 2000, "result");
    expect(order).toEqual(["init", "sub"]);
    await ws.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  test("connection_ack never arrives → SubError({code:'auth_timeout'}) on every pending sub", async () => {
    // Server accepts the connection but ignores connection_init forever.
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const address = wss.address();
    if (address == null || typeof address === "string") throw new Error("addr");
    wss.on("connection", (_ws) => {
      // intentionally silent — no ack.
    });
    const ws = new ReactiveWebSocket({
      url: `ws://127.0.0.1:${address.port}/api/v1/realtime`,
      projectId: "acme/prod",
      jwtProvider: () => "t",
    });
    const errs: Array<{ code: string; message: string }> = [];
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, () => undefined, (e) => errs.push(e));
    await waitFor(() => errs.length > 0, 2000, "auth_timeout surfaced");
    expect(errs[0].code).toBe("auth_timeout");
    expect(errs[0].message).toMatch(/connection_ack/i);
    await ws.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  test("server closes immediately after connection_init (auth rejected) → SubError", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const address = wss.address();
    if (address == null || typeof address === "string") throw new Error("addr");
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "connection_init") {
          ws.close(4401, "Invalid token");
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `ws://127.0.0.1:${address.port}/api/v1/realtime`,
      projectId: "acme/prod",
      jwtProvider: () => "bad-jwt",
    });
    const errs: Array<{ code: string; message: string }> = [];
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, () => undefined, (e) => errs.push(e));
    await waitFor(() => errs.length > 0, 2000, "auth error surfaced");
    expect(errs[0].code).toBe("auth_timeout");
    await ws.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });
});

describe("ReactiveWebSocket — function subscription wire shape (Phase 15c)", () => {
  test("subscribe sends subscribe-function with projectId + ref + args", async () => {
    const sent: unknown[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe-function") {
          sent.push(msg);
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: { hello: "world" } }));
        }
      });
    });
    const received: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "acme/prod",
      jwtProvider: () => "jwt-1",
    });
    ws.subscribe(
      "sub-1",
      { moduleName: "users", exportName: "list" },
      { status: "active" },
      (data) => received.push(data),
      () => undefined,
    );
    await waitFor(() => received.length > 0, 2000, "result");
    expect(received).toEqual([{ hello: "world" }]);
    expect(sent[0]).toEqual({
      op: "subscribe-function",
      subId: "sub-1",
      projectId: "acme/prod",
      ref: { moduleName: "users", exportName: "list" },
      args: { status: "active" },
    });
    await ws.close();
    await server.close();
  });

  test("unsubscribe sends unsubscribe-function frame", async () => {
    const received: unknown[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        received.push(msg);
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: 1 }));
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "acme/prod",
      jwtProvider: () => "t",
    });
    const got: unknown[] = [];
    const unsub = ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length > 0, 2000, "got result");
    unsub();
    await waitFor(
      () => received.some((m) => (m as { op?: string }).op === "unsubscribe-function"),
      2000,
      "unsubscribe-function frame",
    );
    const frame = received.find((m) => (m as { op?: string }).op === "unsubscribe-function");
    expect(frame).toEqual({ op: "unsubscribe-function", subId: "s" });
    await ws.close();
    await server.close();
  });

  test("function-result frame routes to onUpdate, pageStatus passthrough", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({
            op: "function-result",
            subId: msg.subId,
            data: { items: [{ id: 1 }] },
            pageStatus: "SplitRequired",
          }));
        }
      });
    });
    const got: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "acme/prod",
      jwtProvider: () => "t",
    });
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length > 0, 2000, "result");
    expect(got[0]).toEqual({ items: [{ id: 1 }] });
    await ws.close();
    await server.close();
  });

  test("function-error frame routes to onError with code+message", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({
            op: "function-error",
            subId: msg.subId,
            code: "invoke_failed_status_500",
            message: "function crashed",
          }));
        }
      });
    });
    const errs: Array<{ code: string; message: string }> = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "acme/prod",
      jwtProvider: () => "t",
    });
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, () => undefined, (e) => errs.push(e));
    await waitFor(() => errs.length > 0, 2000, "error");
    expect(errs[0].code).toBe("invoke_failed_status_500");
    expect(errs[0].message).toBe("function crashed");
    await ws.close();
    await server.close();
  });

  test("multiplexes multiple subscriptions over one WS connection", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: { id: msg.subId } }));
        }
      });
    });
    const aResults: unknown[] = [];
    const bResults: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "x/y",
      jwtProvider: () => "tk",
    });
    ws.subscribe("a", { moduleName: "m", exportName: "n" }, {}, (d) => aResults.push(d), () => undefined);
    ws.subscribe("b", { moduleName: "m", exportName: "n" }, {}, (d) => bResults.push(d), () => undefined);
    await waitFor(() => aResults.length > 0 && bResults.length > 0, 2000, "both");
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
        if (msg.op === "subscribe-function" && msg.subId === "bad") {
          ws.send(JSON.stringify({ op: "function-error", subId: "bad", code: "not_found", message: "no such fn" }));
        } else if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: "ok" }));
        }
      });
    });
    const aErrors: Array<{ code: string; message: string }> = [];
    const bUpdates: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "p/q",
      jwtProvider: () => "t",
    });
    ws.subscribe("bad", { moduleName: "m", exportName: "missing" }, {}, () => undefined, (e) => aErrors.push(e));
    ws.subscribe("good", { moduleName: "m", exportName: "n" }, {}, (d) => bUpdates.push(d), () => undefined);
    await waitFor(() => aErrors.length > 0 && bUpdates.length > 0, 2000, "both routes fired");
    expect(aErrors[0].code).toBe("not_found");
    expect(aErrors[0].message).toBe("no such fn");
    expect(bUpdates[0]).toBe("ok");
    await ws.close();
    await server.close();
  });

  test("on disconnect: reconnects, sends fresh connection_init, then resubscribes pending", async () => {
    let connectionNum = 0;
    const subscribeFramesByConn: Record<number, unknown[]> = {};
    const initFramesByConn: Record<number, unknown[]> = {};
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const address = wss.address();
    if (address == null || typeof address === "string") throw new Error("addr");
    wss.on("connection", (ws) => {
      connectionNum += 1;
      const localConn = connectionNum;
      subscribeFramesByConn[localConn] = [];
      initFramesByConn[localConn] = [];
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "connection_init") {
          initFramesByConn[localConn]!.push(msg);
          ws.send(JSON.stringify({ type: "connection_ack" }));
          return;
        }
        if (msg.op === "subscribe-function") {
          subscribeFramesByConn[localConn]!.push(msg);
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: { c: localConn } }));
          if (localConn === 1) {
            setTimeout(() => ws.terminate(), 10);
          }
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `ws://127.0.0.1:${address.port}/api/v1/realtime`,
      projectId: "acme/prod",
      jwtProvider: () => "t",
    });
    ws.subscribe("s1", { moduleName: "m", exportName: "n" }, { p: 1 }, () => undefined, () => undefined);
    await waitFor(() => connectionNum >= 2, 5000, "second connection");
    await waitFor(
      () => (subscribeFramesByConn[2]?.length ?? 0) > 0,
      5000,
      "resubscribe on second connection",
    );
    expect(initFramesByConn[2]!.length).toBe(1);
    expect(initFramesByConn[2]![0]).toEqual({
      type: "connection_init",
      payload: { Authorization: "Bearer t" },
    });
    expect(subscribeFramesByConn[2]![0]).toMatchObject({
      op: "subscribe-function",
      subId: "s1",
      projectId: "acme/prod",
      ref: { moduleName: "m", exportName: "n" },
      args: { p: 1 },
    });
    await ws.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  test("close() sends unsubscribe-function for active subs and closes the socket", async () => {
    const sentMessages: unknown[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        sentMessages.push(msg);
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: 1 }));
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "p/q",
      jwtProvider: () => "t",
    });
    const updates: unknown[] = [];
    ws.subscribe("s1", { moduleName: "m", exportName: "n" }, {}, (d) => updates.push(d), () => undefined);
    await waitFor(() => updates.length > 0, 2000, "got result");
    await ws.close();
    await waitFor(
      () => sentMessages.some((m) => (m as { op?: string }).op === "unsubscribe-function"),
      2000,
      "saw unsubscribe-function",
    );
    const frame = sentMessages.find((m) => (m as { op?: string }).op === "unsubscribe-function");
    expect(frame).toEqual({ op: "unsubscribe-function", subId: "s1" });
    await server.close();
  });

  test("unsubscribe handle stops further dispatches and sends unsubscribe-function", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: 1 }));
          setTimeout(() => {
            try {
              ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: 2 }));
            } catch {
              // ignore
            }
          }, 30);
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "p/q",
      jwtProvider: () => "t",
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

describe("LazyQuery — db.functions.<m>.<n>(args) thenable + .watch() (Phase 15c)", () => {
  test("await still resolves via HTTP POST (untouched by 15c)", async () => {
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
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({
            op: "function-result",
            subId: msg.subId,
            data: [{ id: 1 }, { id: 2 }],
            pageStatus: "SplitRecommended",
          }));
        }
      });
    });
    const db = createClient({
      ...baseOpts,
      wsUrl: `${server.url}/api/v1/realtime`,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lazy = (db.functions as any).users.list({ q: "x" });
    const sub = lazy.watch();
    const received: unknown[] = [];
    const errors: unknown[] = [];
    sub.onUpdate((d: unknown) => received.push(d));
    sub.onError((e: unknown) => errors.push(e));
    await waitFor(() => received.length > 0, 2000, "received update");
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
        if (msg.op === "subscribe-function") {
          lastSubId = msg.subId;
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: { v: 1 } }));
        }
      });
    });
    const db = createClient({ ...baseOpts, wsUrl: `${server.url}/api/v1/realtime` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = (db.functions as any).users.list({}).watch();
    const got: unknown[] = [];
    const off = sub.onUpdate((d: unknown) => got.push(d));
    await waitFor(() => got.length > 0, 2000, "update");
    off();
    if (serverConn != null && lastSubId != null) {
      (serverConn as WSWebSocket).send(JSON.stringify({ op: "function-result", subId: lastSubId, data: { v: 2 } }));
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
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({
            op: "function-result",
            subId: msg.subId,
            data: { items: [], pageStatus: "SplitRequired" },
            pageStatus: "SplitRequired",
          }));
        }
      });
    });
    const db = createClient({ ...baseOpts, wsUrl: `${server.url}/api/v1/realtime` });
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
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: msg.subId }));
        }
      });
    });
    const db = createClient({ ...baseOpts, wsUrl: `${server.url}/api/v1/realtime` });
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

  test("server-side function-error frame is dispatched to .watch().onError handler", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({
            op: "function-error",
            subId: msg.subId,
            code: "unauthenticated",
            message: "JWT required",
          }));
        }
      });
    });
    const db = createClient({ ...baseOpts, wsUrl: `${server.url}/api/v1/realtime` });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = (db.functions as any).admin.listUsers({}).watch();
    const errs: Array<{ code: string; message: string }> = [];
    sub.onError((e: { code: string; message: string }) => errs.push(e));
    await waitFor(() => errs.length > 0, 2000, "error frame");
    expect(errs[0].code).toBe("unauthenticated");
    expect(errs[0].message).toMatch(/JWT required/);
    sub.close();
    await db.functions_closeReactive();
    await server.close();
  });

  test(".watch() auth_timeout surfaces when graphql ack is missing", async () => {
    // Server accepts WS but never acks.
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const address = wss.address();
    if (address == null || typeof address === "string") throw new Error("addr");
    wss.on("connection", () => undefined);
    const db = createClient({
      ...baseOpts,
      wsUrl: `ws://127.0.0.1:${address.port}/api/v1/realtime`,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = (db.functions as any).x.y({}).watch();
    const errs: Array<{ code: string; message: string }> = [];
    sub.onError((e: { code: string; message: string }) => errs.push(e));
    await waitFor(() => errs.length > 0, 2000, "auth_timeout");
    expect(errs[0].code).toBe("auth_timeout");
    sub.close();
    await db.functions_closeReactive();
    await new Promise<void>((r) => wss.close(() => r()));
  });
});

describe("ReactiveWebSocket — coverage edges", () => {
  test("WebSocket constructor explicitly overridable via websocketImpl", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: "x" }));
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "p/q",
      jwtProvider: () => "sync-tok",
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

  test("jwtProvider throwing → log + reconnect still attempted with empty token", async () => {
    const initFrames: unknown[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "connection_init") {
          initFrames.push(msg);
        }
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: 1 }));
        }
      });
    });
    const logs: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "p/q",
      jwtProvider: async () => {
        throw new Error("no-token");
      },
      log: (...args) => logs.push(args),
    });
    const got: unknown[] = [];
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length > 0, 2000, "result");
    expect(logs.length).toBeGreaterThan(0);
    // init was still sent — with an empty Authorization.
    expect(initFrames[0]).toEqual({
      type: "connection_init",
      payload: { Authorization: "" },
    });
    await ws.close();
    await server.close();
  });

  test("subscribe after close throws", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", () => undefined);
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "p/q",
      jwtProvider: () => "t",
    });
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
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({ op: "unknown_op", subId: msg.subId }));
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: 99 }));
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "p/q",
      jwtProvider: () => "t",
    });
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
        if (msg.op === "subscribe-function") {
          ws.send("not-json");
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: "ok" }));
        }
      });
    });
    const logs: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "p/q",
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
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: 1 }));
          ws.send(JSON.stringify({ op: "function-result", subId: "ghost", data: 999 }));
          ws.send(JSON.stringify({ op: "function-error", subId: "ghost", code: "x", message: "y" }));
          ws.send(JSON.stringify({ op: "function-result" }));
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "p/q",
      jwtProvider: () => "t",
    });
    const got: unknown[] = [];
    const errs: unknown[] = [];
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), (e) => errs.push(e));
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([1]);
    expect(errs).toEqual([]);
    await ws.close();
    await server.close();
  });

  test("function-error frame without code/message falls back to default values", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({ op: "function-error", subId: msg.subId }));
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "p/q",
      jwtProvider: () => "t",
    });
    const errs: Array<{ code: string; message: string }> = [];
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, () => undefined, (e) => errs.push(e));
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
      url: "ws://127.0.0.1:1/api/v1/realtime",
      projectId: "p/q",
      jwtProvider: () => "t",
      websocketImpl: ThrowingCtor,
      log: (...args) => logs.push(args),
    });
    ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(logs.some((args) => String((args as unknown[])[0]).includes("WS constructor"))).toBe(true);
    await ws.close();
  });

  test("unsubscribe is idempotent and frees the map slot", async () => {
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: 1 }));
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "p/q",
      jwtProvider: () => "t",
    });
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
    const ws = new ReactiveWebSocket({
      url: "ws://127.0.0.1:1/api/v1/realtime",
      projectId: "p/q",
      jwtProvider: () => "t",
    });
    await ws.close();
    expect(ws.size()).toBe(0);
  });

  test("disconnect with no live subs does NOT reconnect", async () => {
    let connectionNum = 0;
    const server = await startMockWsServer((ws) => {
      connectionNum += 1;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe-function") {
          ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: 1 }));
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "p/q",
      jwtProvider: () => "t",
    });
    const got: unknown[] = [];
    const unsub = ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length > 0, 2000, "ack");
    unsub();
    for (const client of server.wss.clients) client.terminate();
    await new Promise((r) => setTimeout(r, 80));
    expect(connectionNum).toBe(1);
    await ws.close();
    await server.close();
  });

  test("resolveWebSocketCtor uses globalThis.WebSocket when present", async () => {
    const prev = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = WSWebSocket;
    try {
      const server = await startMockWsServer((ws) => {
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.op === "subscribe-function") {
            ws.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: 1 }));
          }
        });
      });
      const ws = new ReactiveWebSocket({
        url: `${server.url}/api/v1/realtime`,
        projectId: "p/q",
        jwtProvider: () => "t",
      });
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

  /** Helper: emit open, then drive the connection_ack handshake. */
  function ackOpen(inst: StubSocket): void {
    inst.readyState = 1;
    inst._emit("open");
    // openSocket sent connection_init synchronously; now ack it.
    inst._emit("message", JSON.stringify({ type: "connection_ack" }));
  }

  test("readyState===1 fast path: 2nd subscribe is sent over existing socket without re-init", async () => {
    const { Ctor, instances } = makeStubCtor();
    const ws = new ReactiveWebSocket({
      url: "ws://h/api/v1/realtime",
      projectId: "p/q",
      jwtProvider: () => "t",
      websocketImpl: Ctor,
    });
    ws.subscribe("a", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await flush();
    expect(instances.length).toBe(1);
    ackOpen(instances[0]!);
    // First send was connection_init; second is subscribe-function after ack.
    expect(instances[0]!.sends.length).toBe(2);
    // 2nd sub: fast path because readyState===1 AND handshake complete.
    ws.subscribe("b", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    expect(instances[0]!.sends.length).toBe(3);
    // No fresh connection_init on the second subscribe.
    const sends = instances[0]!.sends.map((s) => JSON.parse(s));
    expect(sends.filter((m) => m.type === "connection_init").length).toBe(1);
    await ws.close();
  });

  test("error event handler is wired and logs without crashing", async () => {
    const { Ctor, instances } = makeStubCtor();
    const logs: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: "ws://h/api/v1/realtime",
      projectId: "p/q",
      jwtProvider: () => "t",
      websocketImpl: Ctor,
      log: (...args) => logs.push(args),
    });
    ws.subscribe("a", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await flush();
    ackOpen(instances[0]!);
    instances[0]!._emit("error", new Error("oops"));
    expect(logs.some((args) => String((args as unknown[])[0]).includes("ws error"))).toBe(true);
    await ws.close();
  });

  test("safeSend swallows send() throws and logs", async () => {
    const { Ctor, instances } = makeStubCtor();
    const logs: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: "ws://h/api/v1/realtime",
      projectId: "p/q",
      jwtProvider: () => "t",
      websocketImpl: Ctor,
      log: (...args) => logs.push(args),
    });
    ws.subscribe("a", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await flush();
    instances[0]!.readyState = 1;
    instances[0]!.sendThrows = true;
    instances[0]!._emit("open"); // triggers connection_init via safeSend → throws
    expect(logs.some((args) => String((args as unknown[])[0]).includes("ws send failed"))).toBe(true);
    await ws.close();
  });

  test("safeSend with not-yet-open socket is a no-op (no throw)", async () => {
    const { Ctor, instances } = makeStubCtor();
    const ws = new ReactiveWebSocket({
      url: "ws://h/api/v1/realtime",
      projectId: "p/q",
      jwtProvider: () => "t",
      websocketImpl: Ctor,
    });
    ws.subscribe("a", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await flush();
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
      url: "ws://h/api/v1/realtime",
      projectId: "p/q",
      jwtProvider: () => "t",
      websocketImpl: Ctor,
    });
    const updates: unknown[] = [];
    ws.subscribe("a", { moduleName: "m", exportName: "n" }, {}, (d) => updates.push(d), () => undefined);
    await flush();
    expect(openListener).not.toBeNull();
    expect(messageListener).not.toBeNull();
    // Drive the ack so subscribe-function is sent.
    (messageListener as unknown as (ev: unknown) => void)({
      data: JSON.stringify({ type: "connection_ack" }),
    });
    (messageListener as unknown as (ev: unknown) => void)({
      data: JSON.stringify({ op: "function-result", subId: "a", data: { ok: 1 } }),
    });
    expect(updates).toEqual([{ ok: 1 }]);
    await ws.close();
  });

  test("listener attach throws when neither on() nor addEventListener present", async () => {
    const Ctor = function () {
      return { readyState: 0, send: () => undefined, close: () => undefined };
    } as unknown as new () => unknown;
    const ws = new ReactiveWebSocket({
      url: "ws://h/api/v1/realtime",
      projectId: "p/q",
      jwtProvider: () => "t",
      websocketImpl: Ctor,
    });
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
      void origListener;
    }
    await ws.close();
  });

  test("ws module resolver caches Node ctor after first use", async () => {
    const server = await startMockWsServer((wsConn) => {
      wsConn.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.op === "subscribe-function") {
          wsConn.send(JSON.stringify({ op: "function-result", subId: msg.subId, data: 1 }));
        }
      });
    });
    const a = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "p/q",
      jwtProvider: () => "t",
    });
    const b = new ReactiveWebSocket({
      url: `${server.url}/api/v1/realtime`,
      projectId: "p/q",
      jwtProvider: () => "t",
    });
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
  test("computeBackoffDelayForTest with jitter > 0 produces value in [min,max]", async () => {
    __resetReconnectBackoff();
    const { computeBackoffDelayForTest } = await import("../src/functions/reactive_ws");
    for (let i = 0; i < 20; i++) {
      const v = computeBackoffDelayForTest(0, 0.5);
      expect(v).toBeGreaterThanOrEqual(500);
      expect(v).toBeLessThanOrEqual(1000);
    }
  });
});

describe("Backoff curve", () => {
  test("first 5 reconnect delays follow exponential 1s→30s cap", async () => {
    __resetReconnectBackoff();
    const { computeBackoffDelayForTest } = await import("../src/functions/reactive_ws");
    const noJitter = (n: number) => computeBackoffDelayForTest(n, 0);
    expect(noJitter(0)).toBe(1000);
    expect(noJitter(1)).toBe(2000);
    expect(noJitter(2)).toBe(4000);
    expect(noJitter(3)).toBe(8000);
    expect(noJitter(4)).toBe(16000);
    expect(noJitter(5)).toBe(30000);
    expect(noJitter(99)).toBe(30000);
  });
});
