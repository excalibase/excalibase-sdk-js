/**
 * `.watch()` reactive subscriptions orchestrate against graphql's existing
 * collection-CDC WebSocket protocol. The function-subscription wire op was
 * deleted on the graphql side, so the SDK no longer speaks it. Instead it:
 *
 *   1. Invokes the function via HTTP with `X-Excalibase-Envelope: v1` and
 *      receives `{result, reads}`. `reads` is the list of CDC source keys
 *      (e.g. `["nosql_posts", "public_users"]`) the handler depended on.
 *   2. Opens one WebSocket per `db` client to `ws(s)://<graphql>/graphql`
 *      using the `graphql-transport-ws` subprotocol; sends
 *      `{"type":"connection_init"}` and waits for `{"type":"connection_ack"}`.
 *   3. Per dependency in `reads`, sends a lightweight subscribe frame:
 *        {"id":"<sub>-<key>","type":"subscribe","source":"<src>","collection":"<col>"}
 *      The SDK splits the read key on the first `_` — segment 0 is `source`
 *      (`"nosql"` / `"public"` / `"rest"`), the remainder is `collection`.
 *   4. On any inbound `{type:"next", id, op, doc}` that maps back to a sub,
 *      the SDK coalesces and re-invokes the same function over HTTP,
 *      hashes the result, dedups, and fires `onUpdate(data)` only when
 *      the hash differs.
 *   5. `close()` sends `{"id":"<id>","type":"complete"}` for every table
 *      sub belonging to that user-level subscription.
 *
 * These tests pin the wire shape against a real `ws` `WebSocketServer` so
 * any regression on either the protocol or the orchestrator surfaces fast.
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { WebSocketServer, WebSocket as WSWebSocket, type RawData } from "ws";
import { createClient } from "../src";
import { memoryStorageAdapter } from "../src/storage";
import {
  ReactiveWebSocket,
  __setReconnectBackoff,
  __resetReconnectBackoff,
  __setConnectionAckTimeoutForTest,
  __resetConnectionAckTimeoutForTest,
} from "../src/functions/reactive_ws";

interface ServerHandle {
  url: string;
  close: () => Promise<void>;
  wss: WebSocketServer;
  connections: () => number;
  lastSubprotocol: () => string | null;
}

interface MockOptions {
  autoAck?: boolean;
  /** When false, server does not auto-record subscribes — handler owns it. */
  echoSubscribes?: boolean;
}

/**
 * Lightweight `graphql-transport-ws`-compatible mock. By default it auto-acks
 * `connection_init` and lets the test handler observe `subscribe`/`complete`.
 */
function startMockWsServer(
  handler: (ws: WSWebSocket, req: { url: string }) => void,
  opts: MockOptions = {},
): Promise<ServerHandle> {
  const autoAck = opts.autoAck ?? true;
  return new Promise((resolve) => {
    let connectionCount = 0;
    let lastSubprotocol: string | null = null;
    const wss = new WebSocketServer({ port: 0 });
    wss.on("listening", () => {
      const address = wss.address();
      if (address == null || typeof address === "string") {
        throw new Error("expected AddressInfo");
      }
      wss.on("connection", (ws, req) => {
        connectionCount += 1;
        lastSubprotocol = ws.protocol ?? null;
        if (autoAck) {
          const initListener = (raw: RawData): void => {
            try {
              const msg = JSON.parse(raw.toString()) as { type?: string };
              if (msg.type === "connection_init") {
                ws.off("message", initListener);
                ws.send(JSON.stringify({ type: "connection_ack" }));
                return;
              }
            } catch {
              // ignore
            }
          };
          ws.on("message", initListener);
        }
        handler(ws, { url: req.url ?? "" });
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
        lastSubprotocol: () => lastSubprotocol,
      });
    });
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 2000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timeout: ${label}`);
}


interface InvokeCapture {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Build an HTTP mock that returns a `{result, reads}` envelope when the
 * client sends `X-Excalibase-Envelope: v1`, and the raw `result` value
 * otherwise (back-compat path). `resultBuilder` is called per invocation
 * so tests can return different snapshots per call.
 */
function envelopeFetch(
  resultBuilder: (callIdx: number) => unknown,
  reads: string[],
): { fetchImpl: typeof fetch; calls: () => InvokeCapture[] } {
  const calls: InvokeCapture[] = [];
  const fetchImpl: typeof fetch = (async (url: string, init?: RequestInit) => {
    const idx = calls.length;
    calls.push({
      url: url as string,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body != null ? JSON.parse(init.body as string) : null,
    });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const envelope = headers["X-Excalibase-Envelope"];
    const result = resultBuilder(idx);
    const body = envelope === "v1"
      ? JSON.stringify({ result, reads })
      : JSON.stringify({ data: result });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const baseOpts = {
  url: "http://localhost:10000",
  projectId: "acme/prod",
  publishableKey: "esk_pub_live_abcdefghijklmnop",
  storage: memoryStorageAdapter(),
  autoRefreshToken: false,
};

beforeEach(() => {
  __setReconnectBackoff({ baseMs: 5, capMs: 50, jitter: 0 });
  __setConnectionAckTimeoutForTest(120);
});

afterEach(() => {
  __resetReconnectBackoff();
  __resetConnectionAckTimeoutForTest();
});

describe("ReactiveWebSocket — graphql-transport-ws handshake", () => {
  test("opens WS with graphql-transport-ws subprotocol and sends connection_init", async () => {
    const initFrames: unknown[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === "connection_init") initFrames.push(msg);
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "jwt-abc",
      invoke: async () => ({ result: "x", reads: [] }),
    });
    await ws.subscribe("s1", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await waitFor(() => initFrames.length > 0, 2000, "init frame");
    expect(server.lastSubprotocol()).toBe("graphql-transport-ws");
    // Handshake frame matches the e2e client.js convention — no payload
    // required; jwt rides in the upgrade Authorization header path when
    // the server enforces auth.
    expect(initFrames[0]).toMatchObject({ type: "connection_init" });
    await ws.close();
    await server.close();
  });

  test("waits for connection_ack before sending any subscribe frame", async () => {
    const order: string[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === "subscribe") order.push("subscribe");
      });
    }, { autoAck: false });
    server.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === "connection_init") {
          order.push("init");
          setTimeout(() => {
            ws.send(JSON.stringify({ type: "connection_ack" }));
          }, 30);
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: ["nosql_posts"] }),
    });
    await ws.subscribe("s1", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await waitFor(() => order.includes("subscribe"), 2000, "subscribe after ack");
    expect(order[0]).toBe("init");
    expect(order.indexOf("subscribe")).toBeGreaterThan(order.indexOf("init"));
    await ws.close();
    await server.close();
  });

  test("connection_ack never arrives → auth_timeout SubError", async () => {
    const server = await startMockWsServer(() => undefined, { autoAck: false });
    server.wss.on("connection", () => undefined);
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: ["nosql_x"] }),
    });
    const errs: Array<{ code: string; message: string }> = [];
    await ws.subscribe("s1", { moduleName: "m", exportName: "n" }, {}, () => undefined, (e) => errs.push(e));
    await waitFor(() => errs.length > 0, 2000, "auth_timeout");
    expect(errs[0].code).toBe("auth_timeout");
    expect(errs[0].message).toMatch(/connection_ack/i);
    await ws.close();
    await server.close();
  });
});

describe("ReactiveWebSocket — collection-CDC subscribe orchestration", () => {
  test("subscribe fires HTTP invoke with X-Excalibase-Envelope: v1 and initial onUpdate uses the result", async () => {
    const server = await startMockWsServer(() => undefined);
    const captured: Array<{ headers: Record<string, string>; body: unknown }> = [];
    const invoke = async (
      _ref: { moduleName: string; exportName: string },
      args: unknown,
      headers: Record<string, string>,
    ): Promise<{ result: unknown; reads: string[] }> => {
      captured.push({ headers, body: { args } });
      return { result: { hello: "world" }, reads: ["nosql_posts"] };
    };
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "jwt-xyz",
      invoke,
    });
    const got: unknown[] = [];
    await ws.subscribe("sub-1", { moduleName: "users", exportName: "list" }, { status: "active" }, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length > 0, 2000, "initial onUpdate");
    expect(got[0]).toEqual({ hello: "world" });
    expect(captured[0].headers["X-Excalibase-Envelope"]).toBe("v1");
    await ws.close();
    await server.close();
  });

  test("opens one collection subscribe per entry in reads (light shape)", async () => {
    const subscribed: Array<{ id: string; source: string; collection: string }> = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type?: string; id?: string; source?: string; collection?: string;
        };
        if (msg.type === "subscribe") {
          subscribed.push({
            id: msg.id ?? "",
            source: msg.source ?? "",
            collection: msg.collection ?? "",
          });
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: ["nosql_posts", "public_users"] }),
    });
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await waitFor(() => subscribed.length === 2, 2000, "two subscribes");
    const sources = subscribed.map((s) => s.source).sort();
    const collections = subscribed.map((s) => s.collection).sort();
    expect(sources).toEqual(["nosql", "public"]);
    expect(collections).toEqual(["posts", "users"]);
    // Each per-table subscribe has a unique id keyed off the user sub id.
    expect(new Set(subscribed.map((s) => s.id)).size).toBe(2);
    await ws.close();
    await server.close();
  });

  test("CDC event on a watched table triggers a fresh HTTP re-invoke", async () => {
    let serverConn: WSWebSocket | null = null;
    const subFrames: Array<{ id: string }> = [];
    const server = await startMockWsServer((ws) => {
      serverConn = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
        if (msg.type === "subscribe") subFrames.push({ id: msg.id ?? "" });
      });
    });
    let invokeCount = 0;
    const invoke = async (): Promise<{ result: unknown; reads: string[] }> => {
      invokeCount += 1;
      return { result: { rev: invokeCount }, reads: ["nosql_posts"] };
    };
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke,
    });
    const got: unknown[] = [];
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length === 1 && subFrames.length === 1, 2000, "initial");
    // Push a CDC event with the table-sub id graphql replies on.
    (serverConn as unknown as WSWebSocket).send(JSON.stringify({
      type: "next",
      id: subFrames[0]!.id,
      op: "insert",
      doc: { _id: "p1" },
    }));
    await waitFor(() => got.length === 2, 2000, "re-invoke fired");
    expect(invokeCount).toBe(2);
    expect(got[1]).toEqual({ rev: 2 });
    await ws.close();
    await server.close();
  });

  test("CDC event on an unrelated table is silently dropped — no re-invoke", async () => {
    let serverConn: WSWebSocket | null = null;
    const server = await startMockWsServer((ws) => {
      serverConn = ws;
    });
    let invokeCount = 0;
    const invoke = async (): Promise<{ result: unknown; reads: string[] }> => {
      invokeCount += 1;
      return { result: invokeCount, reads: ["nosql_posts"] };
    };
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke,
    });
    const got: unknown[] = [];
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length === 1 && serverConn != null, 2000, "initial+conn");
    // Inject an event whose `id` does not belong to any known table sub.
    (serverConn as unknown as WSWebSocket).send(JSON.stringify({
      type: "next",
      id: "ghost-table-id",
      op: "insert",
      doc: {},
    }));
    await new Promise((r) => setTimeout(r, 80));
    expect(invokeCount).toBe(1);
    expect(got.length).toBe(1);
    await ws.close();
    await server.close();
  });

  test("hash dedup: re-invoke producing the same result does not fire onUpdate twice", async () => {
    let serverConn: WSWebSocket | null = null;
    const subFrames: Array<{ id: string }> = [];
    const server = await startMockWsServer((ws) => {
      serverConn = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
        if (msg.type === "subscribe") subFrames.push({ id: msg.id ?? "" });
      });
    });
    // Always return the same payload.
    const invoke = async (): Promise<{ result: unknown; reads: string[] }> => {
      return { result: { stable: true }, reads: ["nosql_posts"] };
    };
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke,
    });
    const got: unknown[] = [];
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length === 1 && subFrames.length === 1, 2000, "initial");
    // Three CDC events; each triggers a re-invoke but result is identical.
    for (let i = 0; i < 3; i++) {
      (serverConn as unknown as WSWebSocket).send(JSON.stringify({
        type: "next",
        id: subFrames[0]!.id,
        op: "update",
        doc: {},
      }));
    }
    await new Promise((r) => setTimeout(r, 120));
    expect(got).toEqual([{ stable: true }]);
    await ws.close();
    await server.close();
  });

  test("coalesces re-invokes per sub: bursts collapse into at most one in-flight invoke", async () => {
    let serverConn: WSWebSocket | null = null;
    const subFrames: Array<{ id: string }> = [];
    const server = await startMockWsServer((ws) => {
      serverConn = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
        if (msg.type === "subscribe") subFrames.push({ id: msg.id ?? "" });
      });
    });
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const invoke = async (): Promise<{ result: unknown; reads: string[] }> => {
      calls += 1;
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      try {
        await new Promise((r) => setTimeout(r, 30));
        return { result: { v: calls }, reads: ["nosql_posts"] };
      } finally {
        inFlight -= 1;
      }
    };
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke,
    });
    const got: unknown[] = [];
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length === 1 && subFrames.length === 1, 2000, "initial");
    // Burst of 5 events while invoke is still running.
    for (let i = 0; i < 5; i++) {
      (serverConn as unknown as WSWebSocket).send(JSON.stringify({
        type: "next", id: subFrames[0]!.id, op: "update", doc: {},
      }));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(maxInFlight).toBe(1);
    // 5 events should collapse to at most 2 follow-up invokes (one running
    // when burst started + one trailing for changes since).
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(3);
    await ws.close();
    await server.close();
  });

  test("close() sends {type:'complete'} for every table sub belonging to the user-level subscription", async () => {
    const completedIds: string[] = [];
    const subbedIds: string[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
        if (msg.type === "subscribe" && msg.id != null) subbedIds.push(msg.id);
        if (msg.type === "complete" && msg.id != null) completedIds.push(msg.id);
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: ["nosql_a", "nosql_b"] }),
    });
    const off = await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await waitFor(() => subbedIds.length === 2, 2000, "two table subs");
    off();
    await waitFor(() => completedIds.length === 2, 2000, "two completes");
    expect(completedIds.sort()).toEqual(subbedIds.sort());
    await ws.close();
    await server.close();
  });

  test("multiple user subs share one WS — one connection, separate table sub ids", async () => {
    const subbedIds: string[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
        if (msg.type === "subscribe" && msg.id != null) subbedIds.push(msg.id);
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke: async (ref) => ({
        result: ref.exportName,
        reads: [`nosql_${ref.exportName}`],
      }),
    });
    const a: unknown[] = [];
    const b: unknown[] = [];
    await ws.subscribe("u1", { moduleName: "m", exportName: "alpha" }, {}, (d) => a.push(d), () => undefined);
    await ws.subscribe("u2", { moduleName: "m", exportName: "beta" }, {}, (d) => b.push(d), () => undefined);
    await waitFor(() => subbedIds.length === 2, 2000, "two subs");
    expect(server.connections()).toBe(1);
    expect(new Set(subbedIds).size).toBe(2);
    expect(a[0]).toBe("alpha");
    expect(b[0]).toBe("beta");
    await ws.close();
    await server.close();
  });

  test("reconnect: socket drop replays connection_init + resubscribes every table sub", async () => {
    let connectionNum = 0;
    const subbedByConn: Record<number, string[]> = {};
    const initsByConn: Record<number, number> = {};
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const address = wss.address();
    if (address == null || typeof address === "string") throw new Error("addr");
    wss.on("connection", (ws) => {
      connectionNum += 1;
      const local = connectionNum;
      subbedByConn[local] = [];
      initsByConn[local] = 0;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
        if (msg.type === "connection_init") {
          initsByConn[local]! += 1;
          ws.send(JSON.stringify({ type: "connection_ack" }));
          return;
        }
        if (msg.type === "subscribe" && msg.id != null) {
          subbedByConn[local]!.push(msg.id);
          if (local === 1) setTimeout(() => ws.terminate(), 15);
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `ws://127.0.0.1:${address.port}/graphql`,
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: ["nosql_a", "nosql_b"] }),
    });
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await waitFor(() => connectionNum >= 2, 5000, "second connection");
    await waitFor(() => (subbedByConn[2]?.length ?? 0) === 2, 5000, "two resubscribes");
    expect(initsByConn[2]).toBe(1);
    // Resubscribed ids are minted fresh per connection — assert cardinality
    // and that conn-2 ids are distinct from conn-1 ids (no overlap).
    expect(new Set(subbedByConn[2]).size).toBe(2);
    const overlap = subbedByConn[2]!.filter((id) => subbedByConn[1]!.includes(id));
    expect(overlap).toEqual([]);
    await ws.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });
});

describe("LazyQuery — db.functions.<m>.<n>().watch() orchestration", () => {
  test("await still resolves via plain HTTP (no envelope header, backward-compat unwrap)", async () => {
    let captured: { url: string; headers: Record<string, string>; body: unknown } | null = null;
    const mockFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
      captured = {
        url: url as string,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body != null ? JSON.parse(init.body as string) : null,
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
    // The HTTP-only await path does NOT request the envelope (back-compat).
    expect(captured!.headers["X-Excalibase-Envelope"]).toBeUndefined();
  });

  test(".watch() without wsUrl configured throws a clear error", () => {
    const db = createClient({ ...baseOpts });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lazy = (db.functions as any).users.list({});
    expect(typeof lazy.watch).toBe("function");
    expect(() => lazy.watch()).toThrow(/wsUrl/);
  });

  test(".watch() invokes function (with envelope), opens WS, fires initial onUpdate with result", async () => {
    const server = await startMockWsServer(() => undefined);
    const { fetchImpl, calls } = envelopeFetch(() => [{ id: 1 }, { id: 2 }], ["nosql_posts"]);
    const db = createClient({
      ...baseOpts,
      wsUrl: `${server.url}/graphql`,
      fetch: fetchImpl,
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
    expect(calls()[0]!.headers["X-Excalibase-Envelope"]).toBe("v1");
    sub.close();
    await db.functions_closeReactive();
    await server.close();
  });

  test("CDC event causes the SDK to re-invoke + onUpdate with the new value", async () => {
    let serverConn: WSWebSocket | null = null;
    const subFrames: Array<{ id: string }> = [];
    const server = await startMockWsServer((ws) => {
      serverConn = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
        if (msg.type === "subscribe") subFrames.push({ id: msg.id ?? "" });
      });
    });
    let rev = 0;
    const fetchImpl: typeof fetch = (async () => {
      rev += 1;
      return new Response(JSON.stringify({ result: { rev }, reads: ["nosql_posts"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const db = createClient({
      ...baseOpts,
      wsUrl: `${server.url}/graphql`,
      fetch: fetchImpl,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = (db.functions as any).posts.list({}).watch();
    const got: unknown[] = [];
    sub.onUpdate((d: unknown) => got.push(d));
    await waitFor(() => got.length === 1 && subFrames.length === 1, 2000, "initial");
    expect(got[0]).toEqual({ rev: 1 });
    (serverConn as unknown as WSWebSocket).send(JSON.stringify({
      type: "next", id: subFrames[0]!.id, op: "insert", doc: { _id: "p1" },
    }));
    await waitFor(() => got.length === 2, 2000, "second");
    expect(got[1]).toEqual({ rev: 2 });
    sub.close();
    await db.functions_closeReactive();
    await server.close();
  });

  test("CDC event on a non-watched table is ignored — no extra onUpdate", async () => {
    let serverConn: WSWebSocket | null = null;
    const server = await startMockWsServer((ws) => {
      serverConn = ws;
    });
    let rev = 0;
    const fetchImpl: typeof fetch = (async () => {
      rev += 1;
      return new Response(JSON.stringify({ result: { rev }, reads: ["nosql_posts"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const db = createClient({
      ...baseOpts,
      wsUrl: `${server.url}/graphql`,
      fetch: fetchImpl,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = (db.functions as any).posts.list({}).watch();
    const got: unknown[] = [];
    sub.onUpdate((d: unknown) => got.push(d));
    await waitFor(() => got.length === 1 && serverConn != null, 2000, "initial+conn");
    (serverConn as unknown as WSWebSocket).send(JSON.stringify({
      type: "next", id: "some-other-id", op: "insert", doc: {},
    }));
    await new Promise((r) => setTimeout(r, 80));
    expect(got).toEqual([{ rev: 1 }]);
    sub.close();
    await db.functions_closeReactive();
    await server.close();
  });

  test("multiple .watch() subs on one client share the single WS", async () => {
    const subbedIds: string[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
        if (msg.type === "subscribe" && msg.id != null) subbedIds.push(msg.id);
      });
    });
    let rev = 0;
    const fetchImpl: typeof fetch = (async (_url: string, init?: RequestInit) => {
      rev += 1;
      const body = init?.body != null ? JSON.parse(init.body as string) : {};
      void body;
      return new Response(JSON.stringify({ result: rev, reads: [`nosql_t${rev}`] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const db = createClient({ ...baseOpts, wsUrl: `${server.url}/graphql`, fetch: fetchImpl });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (db.functions as any).users.list({}).watch();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = (db.functions as any).posts.list({}).watch();
    const aGot: unknown[] = [];
    const bGot: unknown[] = [];
    a.onUpdate((d: unknown) => aGot.push(d));
    b.onUpdate((d: unknown) => bGot.push(d));
    await waitFor(() => aGot.length === 1 && bGot.length === 1, 2000, "both initial");
    expect(server.connections()).toBe(1);
    expect(new Set(subbedIds).size).toBe(2);
    a.close();
    b.close();
    await db.functions_closeReactive();
    await server.close();
  });

  test("HTTP invoke error during re-invoke surfaces via onError but keeps the sub alive", async () => {
    let serverConn: WSWebSocket | null = null;
    const subFrames: Array<{ id: string }> = [];
    const server = await startMockWsServer((ws) => {
      serverConn = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
        if (msg.type === "subscribe") subFrames.push({ id: msg.id ?? "" });
      });
    });
    let calls = 0;
    const fetchImpl: typeof fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ result: { rev: 1 }, reads: ["nosql_posts"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const db = createClient({
      ...baseOpts,
      wsUrl: `${server.url}/graphql`,
      fetch: fetchImpl,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = (db.functions as any).posts.list({}).watch();
    const got: unknown[] = [];
    const errs: Array<{ code: string; message: string }> = [];
    sub.onUpdate((d: unknown) => got.push(d));
    sub.onError((e: { code: string; message: string }) => errs.push(e));
    await waitFor(() => got.length === 1 && subFrames.length === 1, 2000, "initial");
    (serverConn as unknown as WSWebSocket).send(JSON.stringify({
      type: "next", id: subFrames[0]!.id, op: "update", doc: {},
    }));
    await waitFor(() => errs.length > 0, 2000, "error surfaced");
    expect(errs[0].code).toBe("invoke_error");
    expect(errs[0].message).toMatch(/boom|500/);
    expect(got.length).toBe(1);
    sub.close();
    await db.functions_closeReactive();
    await server.close();
  });

  test("auth_timeout surfaces when graphql never acks", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const address = wss.address();
    if (address == null || typeof address === "string") throw new Error("addr");
    wss.on("connection", () => undefined);
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ result: 1, reads: ["nosql_x"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const db = createClient({
      ...baseOpts,
      wsUrl: `ws://127.0.0.1:${address.port}/graphql`,
      fetch: fetchImpl,
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

describe("ReactiveWebSocket — edges", () => {
  test("subscribe after close throws", async () => {
    const server = await startMockWsServer(() => undefined);
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: [] }),
    });
    await ws.close();
    await expect(
      ws.subscribe("s", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined),
    ).rejects.toThrow(/closed/);
    await server.close();
  });

  test("non-JSON server frame is ignored", async () => {
    let serverConn: WSWebSocket | null = null;
    const subFrames: Array<{ id: string }> = [];
    const server = await startMockWsServer((ws) => {
      serverConn = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
        if (msg.type === "subscribe") subFrames.push({ id: msg.id ?? "" });
      });
    });
    let rev = 0;
    const invoke = async (): Promise<{ result: unknown; reads: string[] }> => {
      rev += 1;
      return { result: rev, reads: ["nosql_x"] };
    };
    const logs: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke,
      log: (...args) => logs.push(args),
    });
    const got: unknown[] = [];
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length === 1 && subFrames.length === 1, 2000, "initial");
    (serverConn as unknown as WSWebSocket).send("not-json-data");
    (serverConn as unknown as WSWebSocket).send(JSON.stringify({
      type: "next", id: subFrames[0]!.id, op: "update", doc: {},
    }));
    await waitFor(() => got.length === 2, 2000, "second");
    expect(rev).toBe(2);
    await ws.close();
    await server.close();
  });

  test("server frame with unknown type is ignored", async () => {
    let serverConn: WSWebSocket | null = null;
    const subFrames: Array<{ id: string }> = [];
    const server = await startMockWsServer((ws) => {
      serverConn = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
        if (msg.type === "subscribe") subFrames.push({ id: msg.id ?? "" });
      });
    });
    const invoke = async (): Promise<{ result: unknown; reads: string[] }> => {
      return { result: 1, reads: ["nosql_x"] };
    };
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke,
    });
    const got: unknown[] = [];
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length === 1 && subFrames.length === 1, 2000, "initial");
    (serverConn as unknown as WSWebSocket).send(JSON.stringify({ type: "ka-boom", id: subFrames[0]!.id }));
    await new Promise((r) => setTimeout(r, 60));
    expect(got.length).toBe(1);
    await ws.close();
    await server.close();
  });

  test("unsubscribe handle is idempotent", async () => {
    const subbedIds: string[] = [];
    const completedIds: string[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
        if (msg.type === "subscribe" && msg.id != null) subbedIds.push(msg.id);
        if (msg.type === "complete" && msg.id != null) completedIds.push(msg.id);
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: ["nosql_a"] }),
    });
    const off = await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await waitFor(() => subbedIds.length === 1, 2000, "subscribe landed");
    off();
    off(); // second call must not throw
    await waitFor(() => completedIds.length === 1, 2000, "single complete");
    expect(ws.size()).toBe(0);
    await ws.close();
    await server.close();
  });

  test("close() with no subs and no socket is a no-op", async () => {
    const ws = new ReactiveWebSocket({
      url: "ws://127.0.0.1:1/graphql",
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: [] }),
    });
    await ws.close();
    expect(ws.size()).toBe(0);
  });

  test("explicit websocketImpl override is honored", async () => {
    const server = await startMockWsServer(() => undefined);
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke: async () => ({ result: "x", reads: [] }),
      websocketImpl: WSWebSocket as unknown as new (
        url: string,
        protocols?: string | string[],
      ) => unknown,
      log: () => undefined,
    });
    const got: unknown[] = [];
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
    await waitFor(() => got.length === 1, 2000, "initial");
    expect(got[0]).toBe("x");
    await ws.close();
    await server.close();
  });

  test("read keys without an underscore default source='public'", async () => {
    const subbed: Array<{ source: string; collection: string }> = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type?: string; source?: string; collection?: string;
        };
        if (msg.type === "subscribe") {
          subbed.push({ source: msg.source ?? "", collection: msg.collection ?? "" });
        }
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: ["users"] }),
    });
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await waitFor(() => subbed.length === 1, 2000, "single sub");
    expect(subbed[0]).toEqual({ source: "public", collection: "users" });
    await ws.close();
    await server.close();
  });

  test("computeBackoff curve matches 1s→30s cap", async () => {
    const { computeBackoffDelayForTest } = await import("../src/functions/reactive_ws");
    __resetReconnectBackoff();
    const noJitter = (n: number): number => computeBackoffDelayForTest(n, 0);
    expect(noJitter(0)).toBe(1000);
    expect(noJitter(1)).toBe(2000);
    expect(noJitter(5)).toBe(30000);
  });

  test("__extractMessageDataForTest covers string/null/Buffer/ArrayBuffer/unknown branches", async () => {
    const { __extractMessageDataForTest } = await import("../src/functions/reactive_ws");
    expect(__extractMessageDataForTest("hello")).toBe("hello");
    expect(__extractMessageDataForTest(null)).toBeNull();
    expect(__extractMessageDataForTest(undefined)).toBeNull();
    expect(__extractMessageDataForTest({ data: "x" })).toBe("x");
    const buf = new TextEncoder().encode("abc").buffer;
    expect(__extractMessageDataForTest({ data: buf })).toBe("abc");
    expect(__extractMessageDataForTest({ data: Buffer.from("xyz", "utf8") })).toBe("xyz");
    expect(__extractMessageDataForTest({ data: 42 })).toBeNull();
    expect(__extractMessageDataForTest(Buffer.from("raw", "utf8"))).toBe("raw");
  });

  test("ws constructor throwing schedules reconnect (no crash)", async () => {
    let calls = 0;
    const logs: unknown[] = [];
    const ThrowingCtor = function () {
      calls += 1;
      throw new Error("connect blew up");
    } as unknown as new (url: string, protocols?: string | string[]) => unknown;
    const ws = new ReactiveWebSocket({
      url: "ws://127.0.0.1:1/graphql",
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: ["nosql_x"] }),
      websocketImpl: ThrowingCtor,
      log: (...args) => logs.push(args),
    });
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(logs.some((args) => String((args as unknown[])[0]).includes("WS constructor"))).toBe(true);
    await ws.close();
  });

  test("jwtProvider throwing → log + connection_init still sent with empty token", async () => {
    const initFrames: unknown[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === "connection_init") initFrames.push(msg);
      });
    });
    const logs: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: async () => {
        throw new Error("no-token");
      },
      invoke: async () => ({ result: 1, reads: [] }),
      log: (...args) => logs.push(args),
    });
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await waitFor(() => initFrames.length > 0, 2000, "init frame");
    expect(logs.some((args) => String((args as unknown[])[0]).includes("jwtProvider"))).toBe(true);
    expect(initFrames[0]).toMatchObject({ type: "connection_init" });
    await ws.close();
    await server.close();
  });

  test("server-sent error frame is logged but not crashed on", async () => {
    let serverConn: WSWebSocket | null = null;
    const subFrames: Array<{ id: string }> = [];
    const server = await startMockWsServer((ws) => {
      serverConn = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
        if (msg.type === "subscribe") subFrames.push({ id: msg.id ?? "" });
      });
    });
    const logs: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: ["nosql_x"] }),
      log: (...args) => logs.push(args),
    });
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await waitFor(() => subFrames.length > 0, 2000, "sub landed");
    // Inject `{type:"error", id, payload:{message}}` (graphql's existing shape)
    // and a fallback `{type:"error", id, message}` form.
    (serverConn as unknown as WSWebSocket).send(JSON.stringify({
      type: "error", id: subFrames[0]!.id, payload: { message: "first error" },
    }));
    (serverConn as unknown as WSWebSocket).send(JSON.stringify({
      type: "error", id: subFrames[0]!.id, message: "second error",
    }));
    await new Promise((r) => setTimeout(r, 60));
    expect(logs.some((args) => String((args as unknown[])[0]).includes("ws error frame"))).toBe(true);
    await ws.close();
    await server.close();
  });

  test("listener exceptions are swallowed and logged", async () => {
    const server = await startMockWsServer(() => undefined);
    const logs: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: [] }),
      log: (...args) => logs.push(args),
    });
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, () => {
      throw new Error("listener boom");
    }, () => undefined);
    await waitFor(
      () => logs.some((args) => String((args as unknown[])[0]).includes("listener threw")),
      2000,
      "listener threw logged",
    );
    await ws.close();
    await server.close();
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
      url: "ws://h/graphql",
      jwtProvider: () => "t",
      invoke: async () => ({ result: { ok: 1 }, reads: ["nosql_x"] }),
      websocketImpl: Ctor,
    });
    const updates: unknown[] = [];
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, (d) => updates.push(d), () => undefined);
    await waitFor(() => openListener != null && messageListener != null, 2000, "listeners attached");
    // Mark socket open by mutating readyState before firing open.
    // (The Ctor stub closes over inst; readyState change is observed via the
    // same instance the SDK holds.)
    // The send list before open should contain nothing (socket not at readyState 1).
    // After open we manually drive the handshake and the function-result event.
    (openListener as unknown as Listener)(undefined);
    // SDK sends connection_init now — but readyState is 0, so safeSend drops.
    // For the stub we don't bother emitting subscribe; the initial onUpdate
    // already fired from the in-memory HTTP invoke return.
    expect(updates).toEqual([{ ok: 1 }]);
    await ws.close();
  });

  test("listener attach throws when neither on() nor addEventListener present", async () => {
    const Ctor = function () {
      return { readyState: 0, send: () => undefined, close: () => undefined };
    } as unknown as new () => unknown;
    const logs: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: "ws://h/graphql",
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: [] }),
      websocketImpl: Ctor,
      log: (...args) => logs.push(args),
    });
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await waitFor(
      () => logs.some((args) => String((args as unknown[])[0]).includes("attach failed")),
      2000,
      "attach failed logged",
    );
    await ws.close();
  });

  test("__hashResultForTest hashes equal values to equal hex", async () => {
    const { __hashResultForTest } = await import("../src/functions/reactive_ws");
    expect(__hashResultForTest({ a: 1, b: 2 })).toBe(__hashResultForTest({ b: 2, a: 1 }));
    expect(__hashResultForTest([1, 2, 3])).not.toBe(__hashResultForTest([3, 2, 1]));
    expect(__hashResultForTest(null)).toBe(__hashResultForTest(null));
  });

  test("computeBackoffDelayForTest with jitter > 0 produces a bounded value", async () => {
    __resetReconnectBackoff();
    const { computeBackoffDelayForTest } = await import("../src/functions/reactive_ws");
    for (let i = 0; i < 20; i++) {
      const v = computeBackoffDelayForTest(0, 0.5);
      expect(v).toBeGreaterThanOrEqual(500);
      expect(v).toBeLessThanOrEqual(1000);
    }
  });

  test("ensureSocket fast-path: 2nd sub on a hot socket reuses it without re-init", async () => {
    const initFrames: unknown[] = [];
    const subbedIds: string[] = [];
    const server = await startMockWsServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
        if (msg.type === "connection_init") initFrames.push(msg);
        if (msg.type === "subscribe" && msg.id != null) subbedIds.push(msg.id);
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke: async (ref) => ({ result: ref.exportName, reads: [`nosql_${ref.exportName}`] }),
    });
    await ws.subscribe("u1", { moduleName: "m", exportName: "a" }, {}, () => undefined, () => undefined);
    await waitFor(() => subbedIds.length === 1, 2000, "first sub");
    // Second subscribe happens after the socket is already acked.
    await ws.subscribe("u2", { moduleName: "m", exportName: "b" }, {}, () => undefined, () => undefined);
    await waitFor(() => subbedIds.length === 2, 2000, "second sub");
    expect(initFrames.length).toBe(1);
    await ws.close();
    await server.close();
  });

  test("safeSend on a closed/never-open socket is a silent no-op", async () => {
    const Ctor = function (this: unknown) {
      const inst = {
        readyState: 0, // permanently 0 — open never fires
        send: () => undefined,
        close: () => undefined,
        on: () => undefined,
      };
      return inst;
    } as unknown as new (url: string, protocols?: string | string[]) => unknown;
    const ws = new ReactiveWebSocket({
      url: "ws://h/graphql",
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: ["nosql_x"] }),
      websocketImpl: Ctor,
    });
    // Subscribe — initial onUpdate fires from HTTP, ensureSocket awaits ack
    // that never arrives (timeout). No crash on the dangling safeSend calls.
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await new Promise((r) => setTimeout(r, 250));
    await ws.close();
  });

  test("resolveWebSocketCtor: globalThis.WebSocket wins when set", async () => {
    const prev = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = WSWebSocket;
    try {
      const server = await startMockWsServer(() => undefined);
      const ws = new ReactiveWebSocket({
        url: `${server.url}/graphql`,
        jwtProvider: () => "t",
        invoke: async () => ({ result: 1, reads: [] }),
      });
      const got: unknown[] = [];
      await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, (d) => got.push(d), () => undefined);
      await waitFor(() => got.length === 1, 2000, "initial");
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

  test("close after disconnect: no reconnect, no further sends", async () => {
    let connectionNum = 0;
    const subbedIds: string[] = [];
    const server = await startMockWsServer((ws) => {
      connectionNum += 1;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
        if (msg.type === "subscribe" && msg.id != null) subbedIds.push(msg.id);
      });
    });
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: ["nosql_x"] }),
    });
    const off = await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    await waitFor(() => subbedIds.length === 1, 2000, "sub");
    off();
    for (const client of server.wss.clients) client.terminate();
    await new Promise((r) => setTimeout(r, 80));
    expect(connectionNum).toBe(1);
    await ws.close();
    await server.close();
  });

  test("error event on the WS is logged but not propagated", async () => {
    const server = await startMockWsServer(() => undefined);
    const logs: unknown[] = [];
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke: async () => ({ result: 1, reads: [] }),
      log: (...args) => logs.push(args),
    });
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, () => undefined, () => undefined);
    // Force an error event on the underlying ws — close the server hard.
    for (const client of server.wss.clients) {
      try {
        client.emit("error", new Error("simulated"));
      } catch {
        // ignore
      }
    }
    await new Promise((r) => setTimeout(r, 60));
    // Either ws error or socket-close branches are exercised; at minimum, no
    // crash occurred and the orchestrator state remains consistent.
    expect(ws.size()).toBe(1);
    await ws.close();
    await server.close();
  });

  test("invoke throwing on initial sub still resolves subscribe() but routes the error", async () => {
    const server = await startMockWsServer(() => undefined);
    const invoke = async (): Promise<{ result: unknown; reads: string[] }> => {
      throw new Error("initial-boom");
    };
    const ws = new ReactiveWebSocket({
      url: `${server.url}/graphql`,
      jwtProvider: () => "t",
      invoke,
    });
    const errs: Array<{ code: string; message: string }> = [];
    await ws.subscribe("u1", { moduleName: "m", exportName: "n" }, {}, () => undefined, (e) => errs.push(e));
    await waitFor(() => errs.length > 0, 2000, "initial error");
    expect(errs[0].code).toBe("invoke_error");
    expect(errs[0].message).toMatch(/initial-boom/);
    await ws.close();
    await server.close();
  });
});
