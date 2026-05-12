/**
 * Phase 15c: reactive WebSocket client for `db.functions.<m>.<n>().watch()`.
 *
 * Connects to the SAME WebSocket endpoint as the existing collection-level
 * CDC subscriptions on the graphql server — `ws(s)://<host>/api/v1/realtime` —
 * and multiplexes function-level subscriptions on top of the same socket.
 *
 *   - Auth handshake: after WS open, the client sends
 *       {"type":"connection_init","payload":{"Authorization":"Bearer <jwt>"}}
 *     and waits for {"type":"connection_ack"} (5 s timeout, configurable via
 *     {@link __setConnectionAckTimeoutForTest}). Until ack arrives, no
 *     `subscribe-function` frames are sent; on timeout or hard disconnect
 *     before ack, every pending sub receives a `SubError({code:"auth_timeout"})`.
 *   - Client→server (after ack):
 *       {op:"subscribe-function",  subId, projectId, ref:{moduleName,exportName}, args}
 *       {op:"unsubscribe-function",subId}
 *   - Server→client:
 *       {op:"function-result",subId,data,pageStatus?}
 *       {op:"function-error",subId,code,message}
 *   - Heartbeat: graphql 15a uses native WebSocket ping/pong frames; the
 *     browser / `ws` library handle them transparently. No application-level
 *     ping op is sent by the server, so the client does not need to reply.
 *
 * Reconnect strategy: exponential 1s → 30s cap (with ±20% jitter), pending
 * subs are replayed on the new socket. JWT is re-read and a fresh
 * `connection_init` is sent on every (re)connect attempt.
 *
 * Runtime: prefers `globalThis.WebSocket` (browser, Deno, Node ≥22). Falls
 * back to the `ws` peer dep (Node 18–21). `ws` is declared as an optional
 * peer dep so browser bundlers don't try to pull it in.
 */

export interface FunctionRefMsg {
  moduleName: string;
  exportName: string;
}

export interface ReactiveWebSocketOptions {
  /** Full WS URL — e.g. `ws(s)://<host>/api/v1/realtime`. */
  url: string;
  /** `{orgSlug}/{projectName}` — appended to every `subscribe-function` frame. */
  projectId: string;
  /** Returns the current JWT. Called on every (re)connect. May return ''. */
  jwtProvider: () => Promise<string> | string;
  /** Optional diagnostic logger; never required. */
  log?: (...args: unknown[]) => void;
  /** Override the WebSocket constructor (tests; rarely used at runtime). */
  websocketImpl?: WebSocketCtor;
}

export interface SubError {
  code: string;
  message: string;
}

type ReadyState = 0 | 1 | 2 | 3;

interface WSLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (ev: unknown) => void): void;
  removeEventListener?(type: string, listener: (ev: unknown) => void): void;
  // Node ws also accepts `on` (EventEmitter style).
  on?(event: string, listener: (...args: unknown[]) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
  // Some impls expose this; we don't depend on it.
  terminate?(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebSocketCtor = new (url: string, protocols?: string | string[]) => any;

interface PendingSub {
  subId: string;
  ref: FunctionRefMsg;
  args: unknown;
  onUpdate: (data: unknown) => void;
  onError: (err: SubError) => void;
  closed: boolean;
}

// ---------- Backoff (module-scoped, test-overridable) ----------

interface BackoffConfig {
  baseMs: number;
  capMs: number;
  jitter: number; // 0..1 fractional jitter
}
const PROD_BACKOFF: BackoffConfig = Object.freeze({ baseMs: 1000, capMs: 30000, jitter: 0.2 });
let activeBackoff: BackoffConfig = PROD_BACKOFF;

/** Test hook — override backoff curve. Reset with {@link __resetReconnectBackoff}. */
export function __setReconnectBackoff(cfg: Partial<BackoffConfig>): void {
  activeBackoff = { ...activeBackoff, ...cfg };
}

/** Test hook — reset to production curve. */
export function __resetReconnectBackoff(): void {
  activeBackoff = PROD_BACKOFF;
}

/** Pure computation of the exponential delay (no jitter applied unless asked). */
export function computeBackoffDelayForTest(attempt: number, jitter: number = activeBackoff.jitter): number {
  const raw = Math.min(activeBackoff.capMs, activeBackoff.baseMs * Math.pow(2, attempt));
  if (jitter <= 0) return raw;
  const min = raw * (1 - jitter);
  return Math.round(min + Math.random() * (raw - min));
}

// ---------- connection_ack timeout (module-scoped, test-overridable) ----------

const PROD_ACK_TIMEOUT_MS = 5000;
let activeAckTimeoutMs = PROD_ACK_TIMEOUT_MS;

/** Test hook — shorten the connection_ack wait for fast unit tests. */
export function __setConnectionAckTimeoutForTest(ms: number): void {
  activeAckTimeoutMs = ms;
}

/** Test hook — reset to the production 5 s ack timeout. */
export function __resetConnectionAckTimeoutForTest(): void {
  activeAckTimeoutMs = PROD_ACK_TIMEOUT_MS;
}

// ---------- Constructor resolution ----------

let cachedNodeWsCtor: WebSocketCtor | null = null;

function resolveWebSocketCtor(explicit?: WebSocketCtor): WebSocketCtor {
  if (explicit != null) return explicit;
  const g = globalThis as unknown as { WebSocket?: WebSocketCtor };
  if (typeof g.WebSocket === "function") return g.WebSocket;
  if (cachedNodeWsCtor != null) return cachedNodeWsCtor;
  try {
    // Late `require` so browser bundlers can tree-shake the `ws` import out.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const wsModule = require("ws") as { default?: WebSocketCtor; WebSocket?: WebSocketCtor } | WebSocketCtor;
    if (typeof wsModule === "function") {
      cachedNodeWsCtor = wsModule as WebSocketCtor;
      return cachedNodeWsCtor;
    }
    if (typeof (wsModule as { WebSocket?: WebSocketCtor }).WebSocket === "function") {
      cachedNodeWsCtor = (wsModule as { WebSocket: WebSocketCtor }).WebSocket;
      return cachedNodeWsCtor;
    }
    if (typeof (wsModule as { default?: WebSocketCtor }).default === "function") {
      cachedNodeWsCtor = (wsModule as { default: WebSocketCtor }).default;
      return cachedNodeWsCtor;
    }
  } catch {
    // fallthrough
  }
  throw new Error(
    "No WebSocket implementation available. In Node <22, install the 'ws' peer dependency.",
  );
}

// ---------- ReactiveWebSocket ----------

export class ReactiveWebSocket {
  private readonly options: ReactiveWebSocketOptions;
  private readonly Ctor: WebSocketCtor;
  private socket: WSLike | null = null;
  private readonly subs = new Map<string, PendingSub>();
  private connecting = false;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once the current socket has received `connection_ack`. */
  private ackReceived = false;
  /** Timer that fires `auth_timeout` if no ack arrives in time. */
  private ackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ReactiveWebSocketOptions) {
    this.options = options;
    this.Ctor = resolveWebSocketCtor(options.websocketImpl);
  }

  /**
   * Register a subscription. Returns an unsubscribe function that sends a
   * server-side `{op:"unsubscribe-function"}` and stops further dispatches.
   */
  subscribe(
    subId: string,
    ref: FunctionRefMsg,
    args: unknown,
    onUpdate: (data: unknown) => void,
    onError: (err: SubError) => void,
  ): () => void {
    if (this.closed) {
      throw new Error("ReactiveWebSocket is closed");
    }
    const sub: PendingSub = { subId, ref, args, onUpdate, onError, closed: false };
    this.subs.set(subId, sub);
    void this.ensureSocketAndSend(sub);
    return () => this.unsubscribe(subId);
  }

  /** Close the WS, send unsubscribes for live subs, and clear timers. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearAckTimer();
    for (const sub of this.subs.values()) {
      if (!sub.closed) {
        this.safeSend({ op: "unsubscribe-function", subId: sub.subId });
        sub.closed = true;
      }
    }
    this.subs.clear();
    const sock = this.socket;
    this.socket = null;
    if (sock != null) {
      try {
        sock.close(1000, "client_close");
      } catch {
        // ignore
      }
    }
  }

  /** Number of active subscriptions. Exposed for tests/diagnostics. */
  size(): number {
    return this.subs.size;
  }

  // ---------- internals ----------

  private unsubscribe(subId: string): void {
    const sub = this.subs.get(subId);
    if (sub == null) return;
    if (!sub.closed) {
      this.safeSend({ op: "unsubscribe-function", subId });
      sub.closed = true;
    }
    this.subs.delete(subId);
  }

  private async ensureSocketAndSend(sub: PendingSub): Promise<void> {
    if (this.socket != null && (this.socket.readyState as ReadyState) === 1 && this.ackReceived) {
      this.sendSubscribe(sub);
      return;
    }
    await this.openSocket();
  }

  private async openSocket(): Promise<void> {
    if (this.connecting) return;
    if (this.closed) return;
    this.connecting = true;
    this.ackReceived = false;
    let token = "";
    try {
      token = await Promise.resolve(this.options.jwtProvider());
    } catch (err) {
      this.options.log?.("jwtProvider threw; reconnecting", err);
    }
    let sock: WSLike;
    try {
      sock = new this.Ctor(this.options.url) as WSLike;
    } catch (err) {
      this.connecting = false;
      this.options.log?.("WS constructor threw", err);
      this.scheduleReconnect();
      return;
    }
    this.socket = sock;
    const wireOpen = (): void => {
      this.connecting = false;
      this.reconnectAttempts = 0;
      // Send `connection_init` immediately and arm the ack timeout. Pending
      // subscribes wait for the ack before any `subscribe-function` is sent.
      this.safeSend({
        type: "connection_init",
        payload: { Authorization: token === "" ? "" : `Bearer ${token}` },
      });
      this.armAckTimer();
    };
    const wireMessage = (data: unknown): void => {
      this.handleMessage(extractMessageData(data));
    };
    const wireClose = (): void => {
      const wasMidHandshake = !this.ackReceived;
      this.clearAckTimer();
      this.socket = null;
      this.connecting = false;
      if (this.closed) return;
      // If the socket was closed BEFORE the handshake completed, surface an
      // auth_timeout on every pending sub — graphql closes the WS when JWT
      // verification fails after `connection_init`. Tests cover both the
      // silent-server (timeout) and hard-close (post-init) paths.
      if (wasMidHandshake) {
        this.failPendingSubs("auth_timeout", "connection_ack not received");
      }
      // Reconnect only if we still have live subs.
      if (this.subs.size === 0) return;
      this.scheduleReconnect();
    };
    const wireError = (err: unknown): void => {
      this.options.log?.("ws error", err);
    };
    try {
      attachListener(sock, "open", () => wireOpen());
      attachListener(sock, "message", (ev: unknown) => wireMessage(ev));
      attachListener(sock, "close", () => wireClose());
      attachListener(sock, "error", (err: unknown) => wireError(err));
    } catch (err) {
      // Unusual: the WS implementation has neither on() nor addEventListener.
      // Surface to the log channel and schedule a reconnect rather than
      // crashing the caller's await chain.
      this.connecting = false;
      this.socket = null;
      this.options.log?.("ws listener attach failed", err);
      this.scheduleReconnect();
    }
  }

  private armAckTimer(): void {
    this.clearAckTimer();
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (this.ackReceived || this.closed) return;
      this.failPendingSubs("auth_timeout", "connection_ack not received within timeout");
      // Drop the socket so the close handler triggers reconnect logic.
      const sock = this.socket;
      this.socket = null;
      if (sock != null) {
        try {
          sock.close(4000, "ack_timeout");
        } catch {
          // ignore
        }
      }
    }, activeAckTimeoutMs);
  }

  private clearAckTimer(): void {
    if (this.ackTimer != null) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
  }

  private failPendingSubs(code: string, message: string): void {
    for (const sub of this.subs.values()) {
      if (sub.closed) continue;
      try {
        sub.onError({ code, message });
      } catch (err) {
        this.options.log?.("onError handler threw", err);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer != null) return;
    const delay = computeBackoffDelayForTest(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, delay);
  }

  private sendSubscribe(sub: PendingSub): void {
    if (sub.closed) return;
    this.safeSend({
      op: "subscribe-function",
      subId: sub.subId,
      projectId: this.options.projectId,
      ref: sub.ref,
      args: sub.args,
    });
  }

  private replayPendingSubscribes(): void {
    for (const sub of this.subs.values()) {
      if (!sub.closed) this.sendSubscribe(sub);
    }
  }

  private safeSend(payload: unknown): void {
    const sock = this.socket;
    if (sock == null) return;
    if ((sock.readyState as ReadyState) !== 1) return;
    try {
      sock.send(JSON.stringify(payload));
    } catch (err) {
      this.options.log?.("ws send failed", err);
    }
  }

  private handleMessage(raw: string | null): void {
    if (raw == null) return;
    let msg: {
      op?: string;
      type?: string;
      subId?: string;
      data?: unknown;
      code?: string;
      message?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      this.options.log?.("ws non-JSON frame ignored");
      return;
    }
    // graphql's collection-sub protocol uses `type:` for connection_ack and
    // legacy `next/error/complete`. Function-sub protocol uses `op:` for
    // function-result / function-error. Both share the same socket.
    if (msg.type === "connection_ack") {
      this.ackReceived = true;
      this.clearAckTimer();
      this.replayPendingSubscribes();
      return;
    }
    switch (msg.op) {
      case "function-result": {
        if (msg.subId == null) return;
        const sub = this.subs.get(msg.subId);
        if (sub == null || sub.closed) return;
        sub.onUpdate(msg.data);
        return;
      }
      case "function-error": {
        if (msg.subId == null) return;
        const sub = this.subs.get(msg.subId);
        if (sub == null || sub.closed) return;
        sub.onError({
          code: typeof msg.code === "string" ? msg.code : "subscription_error",
          message: typeof msg.message === "string" ? msg.message : "subscription error",
        });
        return;
      }
      default:
        return;
    }
  }
}

// ---------- helpers ----------

function attachListener(sock: WSLike, event: string, listener: (arg: unknown) => void): void {
  if (typeof sock.on === "function") {
    // Node `ws`: EventEmitter API. Message handler receives a Buffer.
    sock.on(event, ((...args: unknown[]) => listener(args[0])) as (...a: unknown[]) => void);
    return;
  }
  if (typeof sock.addEventListener === "function") {
    sock.addEventListener(event, (ev) => {
      // Browser MessageEvent: extract `.data`. open/close/error: pass through.
      listener(ev);
    });
    return;
  }
  throw new Error("WebSocket implementation lacks both on() and addEventListener()");
}

/** Test hook — exposes the message-data extractor for unit-level coverage. */
export function __extractMessageDataForTest(ev: unknown): string | null {
  return extractMessageData(ev);
}

function extractMessageData(ev: unknown): string | null {
  if (ev == null) return null;
  if (typeof ev === "string") return ev;
  // Browser MessageEvent
  if (typeof (ev as { data?: unknown }).data !== "undefined") {
    const d = (ev as { data: unknown }).data;
    if (typeof d === "string") return d;
    if (d instanceof ArrayBuffer) return new TextDecoder().decode(d);
    // Node ws default delivers Buffer.
    if (typeof Buffer !== "undefined" && d instanceof Buffer) return d.toString("utf8");
    return null;
  }
  // Node ws raw Buffer
  if (typeof Buffer !== "undefined" && ev instanceof Buffer) return ev.toString("utf8");
  return null;
}
