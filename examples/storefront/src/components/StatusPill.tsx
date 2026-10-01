import type { OrderStatus } from "../lib/types";

const STYLE: Record<OrderStatus, string> = {
  placed: "bg-stone-100 text-stone-700",
  packed: "bg-sky-100 text-sky-800",
  shipped: "bg-amber-100 text-amber-800",
  delivered: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-red-100 text-red-700",
};

export function StatusPill({ status }: { status: OrderStatus }) {
  return <span data-testid="order-status" className={`pill capitalize ${STYLE[status]}`}>{status}</span>;
}
