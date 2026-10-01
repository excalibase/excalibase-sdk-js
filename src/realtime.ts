/**
 * One GraphQL subscription over graphql-transport-ws: open the socket,
 * authenticate in `connection_init` (a browser cannot set headers on a
 * WebSocket), wait for the ack, subscribe, deliver each `next`, and complete
 * on `unsubscribe()`. Each subscription has its own socket.
 */
import { ConfigError, NetworkError } from "./errors";
import type { Subscription } from "./types";

export interface SubscriptionHandlers<T> {
  /** Each event's `data`. */
  next: (data: T) => void;
  /** The server refused the connection or the subscription, or the socket dropped. */
  error?: (error: Error) => void;
  /** The server ended the subscription. */
  complete?: () => void;
}

/** The parts of a WebSocket the subscription uses; the browser's and the `ws` package's both fit. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
}

export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocketLike;

export interface SubscribeRequest {
  url: string;
  query: string;
  variables?: Record<string, unknown>;
  /** Built when the socket opens, so it carries the session current at that moment. */
  connectionPayload: () => Record<string, unknown>;
  WebSocket: WebSocketConstructor;
}

const PROTOCOL = "graphql-transport-ws";
const SUBSCRIPTION_ID = "1";
const OPEN = 1;
const NORMAL_CLOSE = 1000;

interface Message {
  type?: string;
  id?: string;
  payload?: unknown;
}

export function resolveWebSocket(explicit: unknown): WebSocketConstructor {
  const ctor = explicit ?? (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof ctor !== "function") {
    throw new ConfigError(
      "This runtime has no WebSocket. Pass one as the `WebSocket` option of createClient, e.g. `import WebSocket from \"ws\"`.",
    );
  }
  return ctor as WebSocketConstructor;
}

export function subscribe<T>(request: SubscribeRequest, handlers: SubscriptionHandlers<T>): Subscription {
  const socket = new request.WebSocket(request.url, PROTOCOL);
  let finished = false;

  const finish = (code = NORMAL_CLOSE): void => {
    if (finished) return;
    finished = true;
    socket.close(code);
  };
  const fail = (error: Error): void => {
    if (finished) return;
    finish();
    handlers.error?.(error);
  };
  const send = (message: Message): void => socket.send(JSON.stringify(message));

  socket.onopen = () => {
    if (finished) return;
    send({ type: "connection_init", payload: request.connectionPayload() });
  };
  socket.onmessage = (event) => {
    if (finished) return;
    const message = parse(event.data);
    switch (message?.type) {
      case "connection_ack":
        send({ type: "subscribe", id: SUBSCRIPTION_ID, payload: subscribePayload(request) });
        break;
      case "ping":
        send({ type: "pong" });
        break;
      case "next":
        if (message.id === SUBSCRIPTION_ID) handlers.next(dataOf<T>(message.payload));
        break;
      case "error":
        if (message.id === SUBSCRIPTION_ID) fail(new NetworkError(errorText(message.payload, "subscription refused")));
        break;
      case "connection_error":
        fail(new NetworkError(errorText(message.payload, "connection refused")));
        break;
      case "complete":
        if (message.id === SUBSCRIPTION_ID) {
          finish();
          handlers.complete?.();
        }
        break;
      default:
        break;
    }
  };
  socket.onerror = () => undefined; // onclose follows with the code
  socket.onclose = (event) => {
    const reason = event.reason ? `: ${event.reason}` : "";
    fail(new NetworkError(`realtime connection closed (${event.code}${reason})`));
  };

  return {
    unsubscribe: () => {
      if (finished) return;
      if (socket.readyState === OPEN) send({ type: "complete", id: SUBSCRIPTION_ID });
      finish();
    },
  };
}

function subscribePayload(request: SubscribeRequest): Record<string, unknown> {
  return request.variables === undefined
    ? { query: request.query }
    : { query: request.query, variables: request.variables };
}

function parse(data: unknown): Message | null {
  try {
    const parsed: unknown = JSON.parse(String(data));
    return parsed != null && typeof parsed === "object" ? (parsed as Message) : null;
  } catch {
    return null;
  }
}

function dataOf<T>(payload: unknown): T {
  return (payload as { data?: T } | undefined)?.data as T;
}

function errorText(payload: unknown, fallback: string): string {
  const first = Array.isArray(payload) ? payload[0] : payload;
  const message = (first as { message?: unknown } | undefined)?.message;
  return typeof message === "string" && message.length > 0 ? message : fallback;
}
