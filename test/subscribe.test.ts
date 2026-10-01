/**
 * `db.graphql.subscribe(document, handlers)` speaks graphql-transport-ws to the
 * project's realtime path. The token travels in `connection_init` (a browser
 * cannot set headers on a WebSocket).
 */
import { createClient, ConfigError } from "../src";
import { memoryStorageAdapter } from "../src/storage";

class FakeSocket {
  static last: FakeSocket | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  readyState = 0;
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocol?: string | string[],
  ) {
    FakeSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  // test drivers
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function client(extra: Record<string, unknown> = {}) {
  return createClient({
    url: "https://api.example.test",
    projectId: "proj-abc123",
    key: "esk_pub_live_abcdefghijklmnop",
    storage: memoryStorageAdapter(),
    autoRefreshToken: false,
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    ...extra,
  });
}

function withSession(db: ReturnType<typeof client>): void {
  (db.auth as unknown as { session: unknown }).session = {
    accessToken: "jwt-xyz",
    refreshToken: null,
    tokenType: "Bearer",
    expiresAt: Date.now() + 60_000,
    user: null,
  };
}

const QUERY = "subscription { publicOrdersChanges { operation data } }";

describe("db.graphql.subscribe", () => {
  beforeEach(() => {
    FakeSocket.last = null;
  });

  it("opens the project's realtime path, authenticates in connection_init, then subscribes", () => {
    const db = client({ headers: { "X-Excalibase-Role": "staff" } });
    withSession(db);
    db.graphql.subscribe(QUERY, { next: () => undefined }, { since: 1 });

    const socket = FakeSocket.last!;
    expect(socket.url).toBe("wss://api.example.test/proj-abc123/graphql");
    expect(socket.protocol).toBe("graphql-transport-ws");
    socket.open();
    expect(socket.sent[0]).toEqual({
      type: "connection_init",
      payload: {
        Authorization: "Bearer jwt-xyz",
        headers: expect.objectContaining({
          "X-Excalibase-Role": "staff",
          "X-Excalibase-Publishable-Key": "esk_pub_live_abcdefghijklmnop",
        }),
      },
    });
    expect(socket.sent).toHaveLength(1);

    socket.receive({ type: "connection_ack" });
    expect(socket.sent[1]).toEqual({
      type: "subscribe",
      id: "1",
      payload: { query: QUERY, variables: { since: 1 } },
    });
  });

  it("delivers each next payload and answers pings", () => {
    const db = client();
    const seen: unknown[] = [];
    db.graphql.subscribe<{ publicOrdersChanges: { operation: string } }>(QUERY, {
      next: (data) => seen.push(data),
    });
    const socket = FakeSocket.last!;
    socket.open();
    expect(socket.sent[0]).toEqual({ type: "connection_init", payload: { headers: expect.any(Object) } });
    socket.receive({ type: "connection_ack" });
    socket.receive({ type: "ping" });
    socket.receive({ type: "next", id: "1", payload: { data: { publicOrdersChanges: { operation: "INSERT" } } } });
    socket.receive({ type: "next", id: "other", payload: { data: { ignored: true } } });
    expect(seen).toEqual([{ publicOrdersChanges: { operation: "INSERT" } }]);
    expect(socket.sent).toContainEqual({ type: "pong" });
  });

  it("unsubscribe completes the subscription and closes the socket", () => {
    const db = client();
    const sub = db.graphql.subscribe(QUERY, { next: () => undefined });
    const socket = FakeSocket.last!;
    socket.open();
    socket.receive({ type: "connection_ack" });
    sub.unsubscribe();
    expect(socket.sent).toContainEqual({ type: "complete", id: "1" });
    expect(socket.closedWith).toBe(1000);
    sub.unsubscribe();
    expect(socket.sent.filter((m) => m.type === "complete")).toHaveLength(1);
  });

  it("unsubscribe before the socket opens just closes it", () => {
    const db = client();
    const sub = db.graphql.subscribe(QUERY, { next: () => undefined });
    sub.unsubscribe();
    const socket = FakeSocket.last!;
    expect(socket.closedWith).toBe(1000);
    socket.open();
    expect(socket.sent).toEqual([]);
  });

  it("reports a subscription error, then stops", () => {
    const db = client();
    const errors: Error[] = [];
    db.graphql.subscribe(QUERY, { next: () => undefined, error: (e) => errors.push(e) });
    const socket = FakeSocket.last!;
    socket.open();
    socket.receive({ type: "connection_ack" });
    socket.receive({ type: "error", id: "1", payload: [{ message: "table not readable" }] });
    expect(errors.map((e) => e.message)).toEqual(["table not readable"]);
    expect(socket.closedWith).toBe(1000);
  });

  it("reports a refused connection with the server's reason", () => {
    const db = client();
    const errors: Error[] = [];
    db.graphql.subscribe(QUERY, { next: () => undefined, error: (e) => errors.push(e) });
    const socket = FakeSocket.last!;
    socket.open();
    socket.receive({ type: "connection_error", payload: { message: "Invalid or expired token: expired" } });
    socket.drop(1008, "Invalid or expired token: expired");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/expired/);
  });

  it("reports a socket that closes unexpectedly, and completes on a server complete", () => {
    const db = client();
    const errors: Error[] = [];
    let completed = 0;
    db.graphql.subscribe(QUERY, { next: () => undefined, error: (e) => errors.push(e) });
    FakeSocket.last!.open();
    FakeSocket.last!.drop(1006);
    expect(errors[0].message).toMatch(/1006/);

    db.graphql.subscribe(QUERY, { next: () => undefined, complete: () => completed++ });
    const second = FakeSocket.last!;
    second.open();
    second.receive({ type: "connection_ack" });
    second.receive({ type: "complete", id: "1" });
    second.drop(1000);
    expect(completed).toBe(1);
  });

  it("names the WebSocket option when the runtime has none", () => {
    const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
    try {
      const db = client({ WebSocket: undefined });
      expect(() => db.graphql.subscribe(QUERY, { next: () => undefined })).toThrow(ConfigError);
      expect(() => db.graphql.subscribe(QUERY, { next: () => undefined })).toThrow(/`WebSocket`/);
    } finally {
      if (saved !== undefined) (globalThis as { WebSocket?: unknown }).WebSocket = saved;
    }
  });
});
