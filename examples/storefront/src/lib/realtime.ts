// Order changes as they happen, over the project's GraphQL websocket
// (graphql-transport-ws). The token goes in connection_init, since a browser
// cannot set headers on a websocket; the engine sends a change only to callers
// whose select permission covers the row, with only their columns.
import { createClient, type Client } from "graphql-ws";
import type { StoreConfig } from "./config";
import type { OrderStatus } from "./types";

interface OrderRow {
  id: number;
  status?: OrderStatus;
  customer_email?: string | null;
}

// An UPDATE carries the row before and after; an INSERT or DELETE the row.
interface RawChange {
  operation: "INSERT" | "UPDATE" | "DELETE";
  data: OrderRow | { old?: OrderRow; new?: OrderRow };
}

export interface OrderChange {
  operation: RawChange["operation"];
  row: OrderRow;
}

export function toOrderChange(raw: RawChange): OrderChange | null {
  const data = raw.data as { old?: OrderRow; new?: OrderRow } & Partial<OrderRow>;
  const row = data.new ?? data.old ?? (typeof data.id === "number" ? (data as OrderRow) : undefined);
  return row ? { operation: raw.operation, row } : null;
}

export function socketUrl(config: StoreConfig): string {
  return `${config.url.replace(/^http/, "ws")}/${config.projectId}/graphql`;
}

export function watchOrders(
  config: StoreConfig,
  accessToken: string | null,
  onChange: (change: OrderChange) => void,
): () => void {
  const client: Client = createClient({
    url: socketUrl(config),
    connectionParams: () => (accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    retryAttempts: 5,
  });
  const stop = client.subscribe<{ publicOrdersChanges: RawChange }>(
    { query: "subscription { publicOrdersChanges { operation table data } }" },
    {
      next: (message) => {
        const raw = message.data?.publicOrdersChanges;
        const change = raw ? toOrderChange(raw) : null;
        if (change) onChange(change);
      },
      error: (err) => console.warn("order updates stopped", err),
      complete: () => undefined,
    },
  );
  return () => {
    stop();
    void client.dispose();
  };
}
