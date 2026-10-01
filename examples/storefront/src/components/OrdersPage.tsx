import { useQuery } from "@tanstack/react-query";
import { Radio } from "lucide-react";
import { useSession } from "../hooks/session";
import { money } from "../lib/money";
import { myOrders } from "../lib/store";
import { StatusPill } from "./StatusPill";

export function OrdersPage() {
  const { db, role, email } = useSession();
  const orders = useQuery({ queryKey: ["orders", role], queryFn: () => myOrders(db) });

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-4xl">My orders</h1>
        <span className="flex items-center gap-1.5 text-xs text-emerald-700"><Radio size={14} /> Live: status changes appear here as they happen</span>
      </div>
      <p className="text-sm text-stone-500 mt-2">Orders placed by {email}. Nobody else's orders reach this page: the project only lets a customer read their own.</p>
      <div className="mt-8 flex flex-col gap-4" data-testid="orders">
        {orders.data?.length === 0 && <p className="text-stone-500">No orders yet.</p>}
        {orders.data?.map((order) => (
          <div key={order.id} className="card p-5" data-testid={`order-${order.id}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-medium">Order #{order.id}</span>
                <StatusPill status={order.status} />
              </div>
              <span className="font-semibold" data-testid="order-total">{money(order.total, { decimal: true })}</span>
            </div>
            <ul className="mt-3 text-sm text-stone-600">
              {order.publicOrderItems.map((item) => (
                <li key={item.id}>{item.quantity} × {item.publicProductId?.name} at {money(item.unit_price, { decimal: true })}</li>
              ))}
            </ul>
            {order.note && <p className="text-xs text-stone-400 mt-2">Note: {order.note}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
