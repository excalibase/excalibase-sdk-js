import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { getClient, type DemoIdentity } from "../lib/client";
import { ALL_ORDERS_ADMIN, productsQuery } from "../lib/queries";

interface OrderRow {
  id: number;
  status: string;
  total: number;
  customer_id: number;
  created_at: string;
  shopifyCustomers: { id: number; name: string; email: string };
}

interface Variant {
  id: number;
  sku: string;
  color: string | null;
  size: string | null;
  stock_quantity: number;
  price_override: number | null;
}

interface Product {
  id: number;
  name: string;
  price: number;
  status: string;
  shopifyProductVariants: Variant[];
  shopifyReviews: Array<{ id: number; rating: number }>;
}

export function AdminPanel({ identity }: { identity: DemoIdentity }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"inventory" | "orders">("inventory");

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex items-center gap-3 mb-6">
        <ShieldCheck size={20} className="text-rose-600" />
        <h1 className="text-2xl font-bold text-slate-900">Admin</h1>
        <span className="pill bg-rose-50 text-rose-700 ring-1 ring-rose-200 ml-2">
          role: app_admin
        </span>
      </div>

      <div className="flex gap-1 mb-5 border-b border-slate-200">
        <TabButton active={tab === "inventory"} onClick={() => setTab("inventory")}>
          Inventory
        </TabButton>
        <TabButton active={tab === "orders"} onClick={() => setTab("orders")}>
          All orders (cross-customer)
        </TabButton>
      </div>

      {tab === "inventory" && (
        <Inventory identity={identity} onMutated={() =>
          queryClient.invalidateQueries({ queryKey: ["products"] })
        } />
      )}
      {tab === "orders" && <AllOrders identity={identity} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition " +
        (active
          ? "text-brand-700 border-brand-500"
          : "text-slate-500 border-transparent hover:text-slate-700")
      }
    >
      {children}
    </button>
  );
}

function Inventory({ identity, onMutated }: { identity: DemoIdentity; onMutated: () => void }) {
  const q = useQuery<{ shopifyProducts: Product[] }, Error>({
    queryKey: ["admin-products", identity.key],
    queryFn: async () =>
      (await getClient().graphql.query(productsQuery(null))) as { shopifyProducts: Product[] },
  });

  const products = q.data?.shopifyProducts ?? [];

  return (
    <section className="bg-white rounded-lg ring-1 ring-slate-100 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
            <th className="px-4 py-2.5">Product</th>
            <th className="px-4 py-2.5">SKU</th>
            <th className="px-4 py-2.5">Variant</th>
            <th className="px-4 py-2.5 text-right">Price</th>
            <th className="px-4 py-2.5 text-right">Stock</th>
            <th className="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {products.flatMap(p =>
            p.shopifyProductVariants.map(v => (
              <InventoryRow
                key={`${p.id}-${v.id}`}
                product={p}
                variant={v}
                onMutated={onMutated}
              />
            ))
          )}
        </tbody>
      </table>
      {q.isFetching && (
        <div className="px-4 py-2 text-xs text-slate-400 flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> refreshing
        </div>
      )}
    </section>
  );
}

function InventoryRow({
  product,
  variant,
  onMutated,
}: {
  product: Product;
  variant: Variant;
  onMutated: () => void;
}) {
  const [stock, setStock] = useState(variant.stock_quantity);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const dirty = stock !== variant.stock_quantity;

  async function save() {
    setSaving(true);
    try {
      await getClient().rest.patch(
        `/product_variants?id=eq.${variant.id}`,
        { stock_quantity: stock },
        { headers: { "Content-Profile": "shopify" } }
      );
      setSavedAt(Date.now());
      onMutated();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="hover:bg-slate-50">
      <td className="px-4 py-2.5">
        <div className="font-medium text-slate-800">{product.name}</div>
      </td>
      <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{variant.sku}</td>
      <td className="px-4 py-2.5 text-slate-600">
        {[variant.color, variant.size].filter(Boolean).join(" / ") || "—"}
      </td>
      <td className="px-4 py-2.5 text-right font-medium text-slate-700">
        ${Number(variant.price_override ?? product.price).toFixed(2)}
      </td>
      <td className="px-4 py-2.5 text-right">
        <input
          type="number"
          min={0}
          value={stock}
          onChange={e => setStock(parseInt(e.target.value) || 0)}
          className="w-20 px-2 py-1 text-sm rounded ring-1 ring-slate-200 focus:ring-brand-500 focus:outline-none text-right"
        />
      </td>
      <td className="px-4 py-2.5">
        {dirty ? (
          <button onClick={save} disabled={saving} className="btn btn-primary text-xs px-2 py-1">
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            Save
          </button>
        ) : savedAt && Date.now() - savedAt < 4000 ? (
          <span className="text-xs text-emerald-600 font-medium">Saved ✓</span>
        ) : null}
      </td>
    </tr>
  );
}

function AllOrders({ identity }: { identity: DemoIdentity }) {
  const q = useQuery<{ shopifyOrders: OrderRow[] }, Error>({
    queryKey: ["admin-all-orders", identity.key],
    queryFn: async () => (await getClient().graphql.query(ALL_ORDERS_ADMIN)) as { shopifyOrders: OrderRow[] },
  });

  return (
    <section className="bg-white rounded-lg ring-1 ring-slate-100 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
            <th className="px-4 py-2.5">#</th>
            <th className="px-4 py-2.5">Customer</th>
            <th className="px-4 py-2.5">Status</th>
            <th className="px-4 py-2.5">Date</th>
            <th className="px-4 py-2.5 text-right">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {q.data?.shopifyOrders.map(o => (
            <tr key={o.id} className="hover:bg-slate-50">
              <td className="px-4 py-2.5 font-mono text-xs">#{o.id}</td>
              <td className="px-4 py-2.5">
                <div className="font-medium text-slate-800">{o.shopifyCustomers?.name ?? "—"}</div>
                <div className="text-xs text-slate-500">{o.shopifyCustomers?.email}</div>
              </td>
              <td className="px-4 py-2.5">
                <span className="pill bg-slate-100 text-slate-700">{o.status}</span>
              </td>
              <td className="px-4 py-2.5 text-slate-600">
                {new Date(o.created_at).toLocaleDateString()}
              </td>
              <td className="px-4 py-2.5 text-right font-medium text-slate-800">
                ${Number(o.total).toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!q.isLoading && (q.data?.shopifyOrders.length ?? 0) === 0 && (
        <div className="px-4 py-6 text-sm text-slate-400 text-center">No orders.</div>
      )}
    </section>
  );
}
