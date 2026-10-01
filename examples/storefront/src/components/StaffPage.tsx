import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../hooks/session";
import { money } from "../lib/money";
import { allOrders, catalog, createProduct, messageOf, setOrderStatus, updateProduct, type ProductChange } from "../lib/store";
import { ORDER_STATUSES, type OrderStatus, type Product } from "../lib/types";
import { StatusPill } from "./StatusPill";

export function StaffPage() {
  const [tab, setTab] = useState<"orders" | "inventory">("orders");
  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <h1 className="font-display text-4xl">Staff</h1>
      <p className="text-sm text-stone-500 mt-2">
        The custom role <span className="font-mono">staff</span> reads every order and every product, changes order status, and edits the catalog.
      </p>
      <div className="flex gap-2 mt-6">
        <button className={`px-4 py-1.5 rounded-full text-sm ${tab === "orders" ? "bg-stone-900 text-white" : "bg-white ring-1 ring-stone-200"}`} onClick={() => setTab("orders")} data-testid="staff-tab-orders">Orders</button>
        <button className={`px-4 py-1.5 rounded-full text-sm ${tab === "inventory" ? "bg-stone-900 text-white" : "bg-white ring-1 ring-stone-200"}`} onClick={() => setTab("inventory")} data-testid="staff-tab-inventory">Inventory</button>
      </div>
      {tab === "orders" ? <StaffOrders /> : <Inventory />}
    </div>
  );
}

function StaffOrders() {
  const { db, role } = useSession();
  const queryClient = useQueryClient();
  const orders = useQuery({ queryKey: ["orders", role], queryFn: () => allOrders(db) });
  const [error, setError] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: ({ id, status }: { id: number; status: OrderStatus }) => setOrderStatus(db, id, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["orders"] }),
    onError: (err) => setError(messageOf(err)),
  });

  return (
    <div className="card mt-6 overflow-hidden">
      {error && <p className="text-sm text-red-600 p-4">{error}</p>}
      <table className="w-full text-sm" data-testid="staff-orders">
        <thead className="bg-stone-50 text-stone-500 text-left">
          <tr><th className="p-3">Order</th><th className="p-3">Customer</th><th className="p-3">Items</th><th className="p-3">Total</th><th className="p-3">Status</th></tr>
        </thead>
        <tbody>
          {orders.data?.map((order) => (
            <tr key={order.id} className="border-t border-stone-100" data-testid={`staff-order-${order.id}`}>
              <td className="p-3 font-medium">#{order.id}</td>
              <td className="p-3">{order.customer_email}</td>
              <td className="p-3 text-stone-600">{order.publicOrderItems.map((item) => `${item.quantity} × ${item.publicProductId?.name}`).join(", ")}</td>
              <td className="p-3">{money(order.total, { decimal: true })}</td>
              <td className="p-3 flex items-center gap-2">
                <StatusPill status={order.status} />
                <select className="input w-auto py-1" value={order.status} data-testid={`status-select-${order.id}`}
                  onChange={(e) => change.mutate({ id: order.id, status: e.target.value as OrderStatus })}>
                  {ORDER_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Inventory() {
  const { db, role } = useSession();
  const queryClient = useQueryClient();
  const shop = useQuery({ queryKey: ["catalog", role], queryFn: () => catalog(db) });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries();
  const save = useMutation({
    mutationFn: ({ id, change }: { id: number; change: ProductChange }) => updateProduct(db, id, change),
    onSuccess: refresh,
    onError: (err) => setError(messageOf(err)),
  });

  return (
    <div className="mt-6 flex flex-col gap-6">
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="card overflow-hidden">
        <table className="w-full text-sm" data-testid="inventory">
          <thead className="bg-stone-50 text-stone-500 text-left">
            <tr><th className="p-3">Product</th><th className="p-3">Price</th><th className="p-3">Stock</th><th className="p-3">On sale</th></tr>
          </thead>
          <tbody>
            {shop.data?.products.map((product) => (
              <InventoryRow key={product.id} product={product} onSave={(change) => save.mutate({ id: product.id, change })} />
            ))}
          </tbody>
        </table>
      </div>
      <NewProductForm categories={shop.data?.categories ?? []} onCreated={refresh} onError={setError} />
    </div>
  );
}

function InventoryRow({ product, onSave }: { product: Product; onSave: (change: ProductChange) => void }) {
  const [price, setPrice] = useState(String(product.price));
  const [stock, setStock] = useState(String(product.stock));
  const commit = () => {
    const change: ProductChange = {};
    if (Number(price) !== Number(product.price) && Number(price) >= 0) change.price = Number(price);
    if (Number(stock) !== product.stock && Number.isInteger(Number(stock))) change.stock = Number(stock);
    onSave(change);
  };
  return (
    <tr className="border-t border-stone-100" data-testid={`inventory-${product.id}`}>
      <td className="p-3 font-medium">{product.name}</td>
      <td className="p-3"><input className="input w-24" value={price} onChange={(e) => setPrice(e.target.value)} onBlur={commit} data-testid="price" /></td>
      <td className="p-3"><input className="input w-20" value={stock} onChange={(e) => setStock(e.target.value)} onBlur={commit} data-testid="stock" /></td>
      <td className="p-3">
        <input type="checkbox" checked={product.active} onChange={(e) => onSave({ active: e.target.checked })} data-testid="active" />
      </td>
    </tr>
  );
}

const ART = ["lamp", "mat", "pen", "kettle", "mug", "beans", "tote", "sleeve", "stand"];

function NewProductForm({ categories, onCreated, onError }: {
  categories: { id: number; name: string }[];
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  const { db } = useSession();
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [stock, setStock] = useState("10");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [art, setArt] = useState(ART[0]);
  const create = useMutation({
    mutationFn: () => createProduct(db, {
      categoryId: categoryId ?? categories[0]?.id ?? 1,
      name: name.trim(),
      description: "New in the shop.",
      price: Number(price),
      stock: Number(stock),
      imageUrl: `/products/${art}.svg`,
    }),
    onSuccess: () => {
      setName("");
      setPrice("");
      onCreated();
    },
    onError: (err) => onError(messageOf(err)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <form onSubmit={submit} className="card p-5 flex flex-wrap items-end gap-3" data-testid="new-product">
      <h2 className="font-display text-xl w-full">Add a product</h2>
      <input className="input w-56" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required data-testid="new-name" />
      <input className="input w-24" placeholder="Price" value={price} onChange={(e) => setPrice(e.target.value)} required inputMode="decimal" data-testid="new-price" />
      <input className="input w-20" placeholder="Stock" value={stock} onChange={(e) => setStock(e.target.value)} required inputMode="numeric" />
      <select className="input w-36" value={categoryId ?? ""} onChange={(e) => setCategoryId(Number(e.target.value))}>
        {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select>
      <select className="input w-32" value={art} onChange={(e) => setArt(e.target.value)} aria-label="Picture">
        {ART.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <button className="btn btn-primary" disabled={create.isPending} data-testid="new-submit">Add</button>
    </form>
  );
}
