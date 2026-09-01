import * as Dialog from "@radix-ui/react-dialog";
import { X, Trash2, Loader2, AlertCircle, Check } from "lucide-react";
import { useState } from "react";
import { useCart } from "../hooks/cart";
import { getClient, userIdOf, type DemoIdentity } from "../lib/client";

export function CartDrawer({
  open,
  onClose,
  identity,
}: {
  open: boolean;
  onClose: () => void;
  identity: DemoIdentity;
}) {
  const cart = useCart();
  const [checkingOut, setCheckingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<number | null>(null);

  async function checkout() {
    if (cart.items.length === 0) return;
    setCheckingOut(true);
    setError(null);
    setSuccess(null);
    try {
      const customerId = userIdOf(identity);
      const total = cart.totalCents / 100;
      // Create the order — RLS WITH CHECK (customer_id = current_customer_id())
      // means a customer can only place orders as themselves.
      const orderResp = (await getClient().rest.post(
        "/orders?select=id",
        {
          customer_id: customerId,
          status: "pending",
          total,
          notes: "Placed via storefront demo",
        },
        {
          headers: {
            "Content-Profile": "shopify",
            Prefer: "return=representation",
          },
        }
      )) as { data?: Array<{ id: number }> } | Array<{ id: number }> | { id: number };

      // Excalibase's REST envelope is sometimes {data: [...]}, sometimes
      // raw — accept both.
      let orderId: number | null = null;
      if (Array.isArray(orderResp)) orderId = orderResp[0]?.id ?? null;
      else if ((orderResp as { data?: Array<{ id: number }> })?.data) {
        orderId = (orderResp as { data: Array<{ id: number }> }).data[0]?.id ?? null;
      } else if ((orderResp as { id: number })?.id) {
        orderId = (orderResp as { id: number }).id;
      }

      if (!orderId) throw new Error("Order created but no id returned");

      // Order items.
      for (const item of cart.items) {
        await getClient().rest.post(
          "/order_items",
          {
            order_id: orderId,
            variant_id: item.variantId,
            quantity: item.quantity,
            price_at_purchase: item.price,
          },
          { headers: { "Content-Profile": "shopify" } }
        );
      }
      cart.clear();
      setSuccess(orderId);
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 240) : String(e));
    } finally {
      setCheckingOut(false);
    }
  }

  const canCheckout = identity.key !== "anon" && cart.items.length > 0;

  return (
    <Dialog.Root open={open} onOpenChange={open => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-40" />
        <Dialog.Content
          className="fixed right-0 top-0 h-full w-[440px] max-w-full bg-white shadow-2xl z-50 flex flex-col outline-none"
        >
          <header className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
            <Dialog.Title className="text-lg font-semibold text-slate-900">
              Shopping cart
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="btn-icon"><X size={18} /></button>
            </Dialog.Close>
          </header>

          {success != null ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
              <div className="w-12 h-12 rounded-full bg-emerald-100 grid place-items-center text-emerald-700 mb-3">
                <Check size={24} />
              </div>
              <h3 className="font-semibold text-slate-900 mb-1">Order #{success} placed</h3>
              <p className="text-sm text-slate-500">
                The row was inserted under <span className="font-mono">app_authenticated</span> with{" "}
                <span className="font-mono">customer_id = {userIdOf(identity)}</span>. Check the
                "My orders" tab.
              </p>
              <button onClick={() => setSuccess(null)} className="btn mt-5">
                Continue shopping
              </button>
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-3">
                {cart.items.length === 0 && (
                  <div className="text-sm text-slate-400 italic text-center py-8">
                    Your cart is empty.
                  </div>
                )}
                {cart.items.map(item => (
                  <div key={item.variantId} className="flex items-start gap-3 py-3 border-b border-slate-100 last:border-0">
                    <div className="w-14 h-14 rounded-md bg-gradient-to-br from-pink-100 to-purple-200 grid place-items-center text-2xl">
                      📦
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{item.productName}</div>
                      <div className="text-xs text-slate-500 font-mono mt-0.5">
                        {item.color ?? item.sku}
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        <input
                          type="number"
                          min={1}
                          value={item.quantity}
                          onChange={e => cart.setQty(item.variantId, parseInt(e.target.value) || 1)}
                          className="w-14 px-2 py-1 text-xs rounded ring-1 ring-slate-200 focus:ring-brand-500 focus:outline-none"
                        />
                        <span className="text-xs text-slate-400">×</span>
                        <span className="text-sm font-medium text-slate-700">
                          ${item.price.toFixed(2)}
                        </span>
                      </div>
                    </div>
                    <button onClick={() => cart.remove(item.variantId)} className="btn-icon">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="px-5 py-4 border-t border-slate-100">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-slate-500">Total</span>
                  <span className="text-xl font-bold text-slate-900">
                    ${(cart.totalCents / 100).toFixed(2)}
                  </span>
                </div>

                {error && (
                  <div className="mb-3 px-3 py-2 rounded bg-red-50 ring-1 ring-red-200 text-xs text-red-700 font-mono">
                    {error}
                  </div>
                )}

                {identity.key === "anon" ? (
                  <div className="px-3 py-2.5 rounded-md bg-amber-50 ring-1 ring-amber-200 text-sm text-amber-900 flex items-start gap-2 mb-2">
                    <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                    <span>
                      Sign in to checkout — RLS rejects orders from <span className="font-mono">app_anon</span>.
                    </span>
                  </div>
                ) : null}

                <button
                  onClick={checkout}
                  disabled={!canCheckout || checkingOut}
                  className="btn btn-primary w-full"
                >
                  {checkingOut ? <Loader2 size={14} className="animate-spin" /> : null}
                  Checkout as {identity.label}
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
