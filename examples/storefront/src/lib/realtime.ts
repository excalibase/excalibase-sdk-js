// Order changes as they happen, over the project's realtime WebSocket through
// the SDK (which sends the session's token in connection_init). The engine
// sends a change only to callers whose select permission covers the row, with
// only their columns.
import type { DbClient } from "@excalibase/sdk";
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

export function watchOrders(db: DbClient, onChange: (change: OrderChange) => void): () => void {
  const subscription = db.graphql.subscribe<{ publicOrdersChanges: RawChange }>(
    "subscription { publicOrdersChanges { operation table data } }",
    {
      next: (data) => {
        const raw = data?.publicOrdersChanges;
        const change = raw ? toOrderChange(raw) : null;
        if (change) onChange(change);
      },
      error: (err) => console.warn("order updates stopped", err),
    },
  );
  return () => subscription.unsubscribe();
}
