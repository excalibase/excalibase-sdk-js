import { useQuery } from "@tanstack/react-query";
import { Package, Loader2 } from "lucide-react";
import { getClient, type DemoIdentity } from "../lib/client";
import { MY_ORDERS } from "../lib/queries";

interface OrderItem {
  id: number;
  quantity: number;
  price_at_purchase: number;
  shopifyProductVariants: {
    id: number;
    sku: string;
    color: string | null;
    shopifyProducts: { id: number; name: string; slug: string };
  };
}

interface Order {
  id: number;
  status: string;
  total: number;
  notes: string | null;
  created_at: string;
  shopifyOrderItems: OrderItem[];
}

const STATUS_COLORS: Record<string, string> = {
  pending:    "bg-amber-50 text-amber-700 ring-amber-200",
  paid:       "bg-emerald-50 text-emerald-700 ring-emerald-200",
  shipped:    "bg-blue-50 text-blue-700 ring-blue-200",
  delivered:  "bg-violet-50 text-violet-700 ring-violet-200",
  cancelled:  "bg-slate-100 text-slate-600 ring-slate-300",
};

export function OrdersPanel({ identity }: { identity: DemoIdentity }) {
  const q = useQuery<{ shopifyOrders: Order[] }, Error>({
    queryKey: ["my-orders", identity.key],
    queryFn: async () => (await getClient().graphql.query(MY_ORDERS)) as { shopifyOrders: Order[] },
  });

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center gap-3 mb-6">
        <Package size={20} className="text-slate-700" />
        <h1 className="text-2xl font-bold text-slate-900">My orders</h1>
        {q.isFetching && <Loader2 size={14} className="animate-spin text-slate-400" />}
      </div>

      {q.error && (
        <div className="bg-red-50 ring-1 ring-red-200 rounded-lg p-4 text-sm text-red-700">
          <span className="font-mono">{q.error.message.split("\n")[0].slice(0, 280)}</span>
        </div>
      )}

      {!q.isLoading && (q.data?.shopifyOrders.length ?? 0) === 0 && (
        <div className="bg-white rounded-lg ring-1 ring-slate-100 p-10 text-center">
          <div className="w-12 h-12 rounded-full bg-slate-100 grid place-items-center text-slate-400 mx-auto mb-3">
            <Package size={20} />
          </div>
          <h2 className="font-semibold text-slate-900">No orders yet</h2>
          <p className="text-sm text-slate-500 mt-1 max-w-sm mx-auto">
            Add something to your cart and check out — or switch identities to see orders
            placed by other demo customers.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {q.data?.shopifyOrders.map(o => {
          const tint = STATUS_COLORS[o.status] ?? STATUS_COLORS.pending;
          return (
            <article key={o.id} className="bg-white rounded-lg ring-1 ring-slate-100 overflow-hidden">
              <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-slate-500">#{o.id}</span>
                  <span className={`pill ring-1 ${tint}`}>{o.status}</span>
                  <span className="text-xs text-slate-400">{new Date(o.created_at).toLocaleDateString()}</span>
                </div>
                <div className="text-base font-bold text-slate-900">
                  ${Number(o.total).toFixed(2)}
                </div>
              </header>
              <div className="px-4 py-3 space-y-1.5">
                {o.shopifyOrderItems.map(item => (
                  <div key={item.id} className="flex items-center gap-3 text-sm">
                    <span className="font-mono text-slate-300 w-8 text-right">×{item.quantity}</span>
                    <span className="flex-1 text-slate-700">
                      {item.shopifyProductVariants?.shopifyProducts?.name ?? "—"}
                      <span className="text-slate-400 ml-2 text-xs">
                        {item.shopifyProductVariants?.color ?? item.shopifyProductVariants?.sku}
                      </span>
                    </span>
                    <span className="text-slate-700 font-mono text-xs">
                      ${Number(item.price_at_purchase).toFixed(2)}
                    </span>
                  </div>
                ))}
                {o.notes && (
                  <div className="text-xs italic text-slate-400 mt-2 pt-2 border-t border-slate-100">
                    {o.notes}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
