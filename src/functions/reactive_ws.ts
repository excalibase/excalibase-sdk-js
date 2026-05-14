/**
 * Reactive WebSocket orchestrator for `db.functions.<m>.<n>().watch()`.
 *
 * The SDK speaks graphql's existing collection-CDC protocol — there is no
 * function-subscription WebSocket op on the server. The flow per user-level
 * subscription is:
 *
 *   1. HTTP-invoke the function via {@link ReactiveWebSocketOptions.invoke}
 *      with `X-Excalibase-Envelope: v1` (set by the caller — typically
 *      {@link FunctionsNamespace}). The response carries `{result, reads}`
 *      where `reads` is the list of CDC source keys the handler depended on
 *      (e.g. `"nosql_posts"`, `"public_users"`).
 *   2. Open one WS per client to `ws(s)://<graphql>/graphql` with the
 *      `graphql-transport-ws` subprotocol; send `{"type":"connection_init"}`
 *      and wait for `{"type":"connection_ack"}`. The JWT is captured per
 *      (re)connect via {@link ReactiveWebSocketOptions.jwtProvider} so the
 *      WS upgrade handshake or `connection_init` payload (if the server
 *      enforces auth there) sees the freshest token.
 *   3. For each entry in `reads` send a lightweight subscribe frame
 *      `{"id":<table-sub-id>,"type":"subscribe","source":<src>,"collection":<col>}`.
 *      Keys are split on the first `_`: segment 0 is `source` (`"nosql"` /
 *      `"public"` / `"rest"`), the remainder is `collection`. Keys without
 *      a `_` default to `source="public"`.
 *   4. On `{"type":"next","id":<table-sub-id>,...}` the orchestrator finds
 *      the owning user-sub and schedules a re-invoke. Bursts coalesce per
 *      sub: at most one invoke is in flight; another fires once if events
 *      arrived during the previous run.
 *   5. The new result is SHA-256-hashed (with a stable JSON-stringify); if
 *      the hash differs from the last-emitted hash the user's `onUpdate`
 *      fires with the new value.
 *   6. `unsubscribe()` / `close()` send `{"type":"complete","id":<table-sub-id>}`
 *      for every table sub belonging to the user-level subscription.
 *
 * Reconnect: exponential 1s → 30s cap (±20% jitter). On every (re)connect a
 * fresh `connection_init` is sent and every live user sub re-issues its
 * per-table subscribe frames (new table-sub ids on a new connection).
 */

import { createHash } from "crypto";

export interface FunctionRefMsg {
  moduleName: string;
  exportName: string;
}

/**
 * The envelope-aware HTTP invoker. Caller is responsible for sending the
 * `X-Excalibase-Envelope: v1` header on its outbound POST. Returns the
 * parsed `{result, reads}` body.
 */
export type InvokeFn = (
  ref: FunctionRefMsg,
  args: unknown,
  headers: Record<string, string>,
) => Promise<{ result: unknown; reads: readonly string[] }>;

export interface ReactiveWebSocketOptions {
  /** Full WS URL — e.g. `ws(s)://<graphql>/graphql`. */
  url: string;
  /** Returns the current JWT. Called on every (re)connect. May return ''. */
  jwtProvider: () => Promise<string> | string;
  /**
   * Envelope-aware HTTP invoker. Called for the initial value and on every
   * dependency-triggered re-invoke. The orchestrator passes through any
   * extra headers it needs (currently none); callers may inject auth.
   */
  invoke: InvokeFn;
  /** Optional diagnostic logger. */
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
  on?(event: string, listener: (...args: unknown[]) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
  terminate?(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebSocketCtor = new (url: string, protocols?: string | string[]) => any;

interface UserSub {
  /** Externally provided id (used as the prefix for per-table ids). */
  userId: string;
  ref: FunctionRefMsg;
  args: unknown;
  reads: string[];
  /** collection → per-table sub id sent to graphql. */
  tableSubs: Map<string, string>;
  /** Inverse lookup: per-table sub id → collection key. */
  tableSubIds: Set<string>;
  lastResultHash: string | null;
  onUpdate: (data: unknown) => void;
  onError: (err: SubError) => void;
  closed: boolean;
  /** Coalescing flags for re-invoke. */
  invoking: boolean;
  pendingRerun: boolean;
  /** Monotonic counter for per-table ids per user sub. */
  tableIdCounter: number;
}

// ---------- Backoff (module-scoped, test-overridable) ----------

interface BackoffConfig {
  baseMs: number;
  capMs: number;
  jitter: number;
}
const PROD_BACKOFF: BackoffConfig = Object.freeze({ baseMs: 1000, capMs: 30000, jitter: 0.2 });
let activeBackoff: BackoffConfig = PROD_BACKOFF;

export function __setReconnectBackoff(cfg: Partial<BackoffConfig>): void {
  activeBackoff = { ...activeBackoff, ...cfg };
}

export function __resetReconnectBackoff(): void {
  activeBackoff = PROD_BACKOFF;
}

export function computeBackoffDelayForTest(attempt: number, jitter: number = activeBackoff.jitter): number {
  const raw = Math.min(activeBackoff.capMs, activeBackoff.baseMs * Math.pow(2, attempt));
  if (jitter <= 0) return raw;
  const min = raw * (1 - jitter);
  return Math.round(min + Math.random() * (raw - min));
}

// ---------- connection_ack timeout (module-scoped, test-overridable) ----------

const PROD_ACK_TIMEOUT_MS = 5000;
let activeAckTimeoutMs = PROD_ACK_TIMEOUT_MS;

export function __setConnectionAckTimeoutForTest(ms: number): void {
  activeAckTimeoutMs = ms;
}

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

// ---------- read-key parsing ----------

/**
 * Parse a CDC source key into `{source, collection}`. Keys are
 * `<source>_<collection>` (e.g. `"nosql_posts"`, `"public_users"`); keys
 * without an underscore default to `source="public"` for safety.
 */
export function parseReadKey(key: string): { source: string; collection: string } {
  const idx = key.indexOf("_");
  if (idx < 0) return { source: "public", collection: key };
  return { source: key.slice(0, idx), collection: key.slice(idx + 1) };
}

// ---------- Stable JSON for hashing ----------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Exposed for unit-level coverage of hash dedup. */
export function __hashResultForTest(value: unknown): string {
  return sha256(stableStringify(value));
}

// ---------- ReactiveWebSocket ----------

export class ReactiveWebSocket {
  private readonly options: ReactiveWebSocketOptions;
  private readonly Ctor: WebSocketCtor;
  private socket: WSLike | null = null;
  private readonly subs = new Map<string, UserSub>();
  /** per-table sub id → owning user sub id, for fast event dispatch. */
  private readonly tableIndex = new Map<string, string>();
  private connecting = false;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ackReceived = false;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Promise that resolves once the socket has received `connection_ack`. */
  private ackPromise: Promise<void> | null = null;
  private ackResolve: (() => void) | null = null;
  private ackReject: ((err: Error) => void) | null = null;

  constructor(options: ReactiveWebSocketOptions) {
    this.options = options;
    this.Ctor = resolveWebSocketCtor(options.websocketImpl);
  }

  /**
   * Register a user-level subscription. The orchestrator immediately invokes
   * the function (envelope on), records `reads`, opens the WS if needed,
   * subscribes per table, and fires the initial `onUpdate`. Returns a
   * teardown function that sends `{type:"complete"}` for each table sub.
   */
  async subscribe(
    userId: string,
    ref: FunctionRefMsg,
    args: unknown,
    onUpdate: (data: unknown) => void,
    onError: (err: SubError) => void,
  ): Promise<() => void> {
    if (this.closed) {
      throw new Error("ReactiveWebSocket is closed");
    }
    const sub: UserSub = {
      userId,
      ref,
      args,
      reads: [],
      tableSubs: new Map(),
      tableSubIds: new Set(),
      lastResultHash: null,
      onUpdate,
      onError,
      closed: false,
      invoking: false,
      pendingRerun: false,
      tableIdCounter: 0,
    };
    this.subs.set(userId, sub);
    void this.initialInvokeAndSubscribe(sub);
    return () => this.unsubscribe(userId);
  }

  /** Close the WS, send complete for every table sub, clear timers. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearAckTimer();
    for (const sub of this.subs.values()) {
      this.sendCompleteForSub(sub);
      sub.closed = true;
    }
    this.subs.clear();
    this.tableIndex.clear();
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

  /** Active user-sub count. Exposed for tests/diagnostics. */
  size(): number {
    return this.subs.size;
  }

  // ---------- internals ----------

  private unsubscribe(userId: string): void {
    const sub = this.subs.get(userId);
    if (sub == null) return;
    if (sub.closed) return;
    sub.closed = true;
    this.sendCompleteForSub(sub);
    for (const id of sub.tableSubIds) this.tableIndex.delete(id);
    this.subs.delete(userId);
  }

  private sendCompleteForSub(sub: UserSub): void {
    for (const id of sub.tableSubIds) {
      this.safeSend({ id, type: "complete" });
    }
  }

  /**
   * Orchestrator entry. Runs the initial invoke, opens the WS, sends
   * `connection_init`, waits for `ack`, then sends per-table subscribe
   * frames. Errors at any step go through `sub.onError` rather than
   * propagating to the subscribe() caller (which already returned).
   */
  private async initialInvokeAndSubscribe(sub: UserSub): Promise<void> {
    let envelope: { result: unknown; reads: readonly string[] };
    try {
      envelope = await this.invokeForSub(sub);
    } catch (err) {
      this.deliverInvokeError(sub, err);
      return;
    }
    if (sub.closed) return;
    sub.reads = [...envelope.reads];
    sub.lastResultHash = sha256(stableStringify(envelope.result));
    this.safeFire(() => sub.onUpdate(envelope.result), sub);
    // Now ensure socket + send table subs.
    try {
      await this.ensureSocket();
    } catch (err) {
      this.deliverError(sub, "auth_timeout", (err as Error).message ?? "connection_ack not received");
      return;
    }
    if (sub.closed) return;
    this.sendTableSubsFor(sub);
  }

  private async invokeForSub(sub: UserSub): Promise<{ result: unknown; reads: readonly string[] }> {
    return this.options.invoke(sub.ref, sub.args, { "X-Excalibase-Envelope": "v1" });
  }

  private deliverInvokeError(sub: UserSub, err: unknown): void {
    if (sub.closed) return;
    const message = err instanceof Error ? err.message : String(err);
    this.deliverError(sub, "invoke_error", message);
  }

  private deliverError(sub: UserSub, code: string, message: string): void {
    this.safeFire(() => sub.onError({ code, message }), sub);
  }

  private safeFire(fn: () => void, sub: UserSub): void {
    if (sub.closed) return;
    try {
      fn();
    } catch (err) {
      this.options.log?.("listener threw", err);
    }
  }

  private sendTableSubsFor(sub: UserSub): void {
    for (const key of sub.reads) {
      const { source, collection } = parseReadKey(key);
      sub.tableIdCounter += 1;
      const tableId = `${sub.userId}-t${sub.tableIdCounter}`;
      sub.tableSubs.set(key, tableId);
      sub.tableSubIds.add(tableId);
      this.tableIndex.set(tableId, sub.userId);
      this.safeSend({ id: tableId, type: "subscribe", source, collection });
    }
  }

  private async ensureSocket(): Promise<void> {
    if (this.socket != null && (this.socket.readyState as ReadyState) === 1 && this.ackReceived) {
      return;
    }
    if (this.ackPromise != null) {
      await this.ackPromise;
      return;
    }
    this.openSocket();
    if (this.ackPromise != null) {
      await this.ackPromise;
    }
  }

  private openSocket(): void {
    if (this.connecting) return;
    if (this.closed) return;
    this.connecting = true;
    this.ackReceived = false;
    this.ackPromise = new Promise<void>((resolve, reject) => {
      this.ackResolve = resolve;
      this.ackReject = reject;
    });
    // Swallow unhandled rejection — every consumer awaits this promise via
    // ensureSocket() or via the close handler that re-throws via deliverError.
    this.ackPromise.catch(() => undefined);
    void this.startSocket();
  }

  private async startSocket(): Promise<void> {
    let token = "";
    try {
      token = await Promise.resolve(this.options.jwtProvider());
    } catch (err) {
      this.options.log?.("jwtProvider threw; reconnecting", err);
    }
    if (this.closed) return;
    let sock: WSLike;
    try {
      sock = new this.Ctor(this.options.url, "graphql-transport-ws") as WSLike;
    } catch (err) {
      this.connecting = false;
      this.options.log?.("WS constructor threw", err);
      this.failAck(new Error("ws_constructor_failed"));
      this.scheduleReconnect();
      return;
    }
    this.socket = sock;
    const wireOpen = (): void => {
      this.connecting = false;
      this.reconnectAttempts = 0;
      const initPayload: Record<string, unknown> =
        token === "" ? {} : { Authorization: `Bearer ${token}` };
      this.safeSend({ type: "connection_init", payload: initPayload });
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
      if (wasMidHandshake) {
        this.failAck(new Error("connection_ack not received"));
      }
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
      this.connecting = false;
      this.socket = null;
      this.options.log?.("ws listener attach failed", err);
      this.failAck(err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
    }
  }

  private armAckTimer(): void {
    this.clearAckTimer();
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (this.ackReceived || this.closed) return;
      this.failAck(new Error("connection_ack not received within timeout"));
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

  private failAck(err: Error): void {
    const reject = this.ackReject;
    this.ackResolve = null;
    this.ackReject = null;
    this.ackPromise = null;
    if (reject != null) reject(err);
    // Also surface auth_timeout on every pending sub that hasn't yet sent
    // its table subscribes.
    for (const sub of this.subs.values()) {
      if (sub.closed) continue;
      if (sub.tableSubIds.size === 0) {
        this.deliverError(sub, "auth_timeout", err.message);
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
      this.openSocket();
    }, delay);
  }

  private replayPendingSubs(): void {
    // Re-issue table subscribes only for subs that already had them on a
    // previous (now-dead) connection. New subs added during this connection
    // (tableSubIds.size === 0) send their own subscribes via the explicit
    // initialInvokeAndSubscribe path — running both would double-subscribe.
    for (const sub of this.subs.values()) {
      if (sub.closed) continue;
      if (sub.tableSubIds.size === 0) continue;
      // Stale table-sub ids on the dead socket — mint new ones.
      for (const id of sub.tableSubIds) this.tableIndex.delete(id);
      sub.tableSubs.clear();
      sub.tableSubIds.clear();
      this.sendTableSubsFor(sub);
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
      type?: string;
      id?: string;
      op?: string;
      doc?: unknown;
      payload?: { message?: string };
      message?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      this.options.log?.("ws non-JSON frame ignored");
      return;
    }
    if (msg.type === "connection_ack") {
      this.ackReceived = true;
      this.clearAckTimer();
      const resolve = this.ackResolve;
      this.ackResolve = null;
      this.ackReject = null;
      // Hold ackPromise === fulfilled state for subsequent awaits.
      if (resolve != null) resolve();
      this.replayPendingSubs();
      return;
    }
    if (msg.type === "next") {
      this.handleTableEvent(msg.id);
      return;
    }
    if (msg.type === "error") {
      const detail = msg.payload?.message ?? msg.message ?? "subscription error";
      this.options.log?.("ws error frame", msg.id, detail);
      return;
    }
    // Unknown frames (e.g. complete, connection_keep_alive) are ignored.
  }

  private handleTableEvent(tableId: string | undefined): void {
    if (tableId == null) return;
    const userId = this.tableIndex.get(tableId);
    if (userId == null) return;
    const sub = this.subs.get(userId);
    if (sub == null || sub.closed) return;
    this.scheduleReinvoke(sub);
  }

  private scheduleReinvoke(sub: UserSub): void {
    if (sub.invoking) {
      sub.pendingRerun = true;
      return;
    }
    void this.runReinvoke(sub);
  }

  private async runReinvoke(sub: UserSub): Promise<void> {
    sub.invoking = true;
    try {
      while (!sub.closed) {
        let envelope: { result: unknown; reads: readonly string[] };
        try {
          envelope = await this.invokeForSub(sub);
        } catch (err) {
          this.deliverInvokeError(sub, err);
          break;
        }
        if (sub.closed) return;
        const newHash = sha256(stableStringify(envelope.result));
        if (newHash !== sub.lastResultHash) {
          sub.lastResultHash = newHash;
          this.safeFire(() => sub.onUpdate(envelope.result), sub);
        }
        // Treat shifted `reads` as a no-op for v1 — extra reads simply mean
        // we'd miss invalidations for new dependencies until the next event
        // arrives on one of the existing subs. We could re-subscribe here,
        // but it deserves a dedicated test pass; current scope only stores
        // the initial reads.
        if (!sub.pendingRerun) break;
        sub.pendingRerun = false;
      }
    } finally {
      sub.invoking = false;
    }
  }
}

// ---------- helpers ----------

function attachListener(sock: WSLike, event: string, listener: (arg: unknown) => void): void {
  if (typeof sock.on === "function") {
    sock.on(event, ((...args: unknown[]) => listener(args[0])) as (...a: unknown[]) => void);
    return;
  }
  if (typeof sock.addEventListener === "function") {
    sock.addEventListener(event, (ev) => listener(ev));
    return;
  }
  throw new Error("WebSocket implementation lacks both on() and addEventListener()");
}

export function __extractMessageDataForTest(ev: unknown): string | null {
  return extractMessageData(ev);
}

function extractMessageData(ev: unknown): string | null {
  if (ev == null) return null;
  if (typeof ev === "string") return ev;
  if (typeof (ev as { data?: unknown }).data !== "undefined") {
    const d = (ev as { data: unknown }).data;
    if (typeof d === "string") return d;
    if (d instanceof ArrayBuffer) return new TextDecoder().decode(d);
    if (typeof Buffer !== "undefined" && d instanceof Buffer) return d.toString("utf8");
    return null;
  }
  if (typeof Buffer !== "undefined" && ev instanceof Buffer) return ev.toString("utf8");
  return null;
}
