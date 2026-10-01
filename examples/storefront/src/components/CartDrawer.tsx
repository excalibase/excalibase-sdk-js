import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Plus, X } from "lucide-react";
import { useSession } from "../hooks/session";
import { money, sumLines } from "../lib/money";
import { cart, messageOf, placeOrder, setQuantity } from "../lib/store";
import { ProductArt } from "./ProductCard";

export function CartDrawer({ open, onClose, onOrdered }: { open: boolean; onClose: () => void; onOrdered: () => void }) {
  const { db, role } = useSession();
  const queryClient = useQueryClient();
  const items = useQuery({ queryKey: ["cart", role], queryFn: () => cart(db), enabled: role === "user" });
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lines = items.data ?? [];
  const total = sumLines(lines.map((item) => ({ price: item.publicProductId?.price ?? 0, quantity: item.quantity })));

  const refresh = () => queryClient.invalidateQueries();
  const change = useMutation({
    mutationFn: ({ id, quantity }: { id: number; quantity: number }) => setQuantity(db, id, quantity),
    onSuccess: refresh,
    onError: (err) => setError(messageOf(err)),
  });
  const checkout = useMutation({
    mutationFn: () => placeOrder(db, lines, note),
    onSuccess: async () => {
      setNote("");
      setError(null);
      await refresh();
      onClose();
      onOrdered();
    },
    onError: (err) => setError(messageOf(err)),
  });

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-stone-900/30 z-40" />
        <Dialog.Content className="fixed z-50 right-0 top-0 h-full w-[420px] bg-white shadow-xl flex flex-col" data-testid="cart-drawer">
          <div className="flex items-center justify-between px-6 h-16 border-b border-stone-200">
            <Dialog.Title className="font-display text-xl">Your cart</Dialog.Title>
            <Dialog.Close className="btn-icon" aria-label="Close"><X size={16} /></Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Items in your cart</Dialog.Description>
          <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
            {lines.length === 0 && <p className="text-stone-500 text-sm">Your cart is empty.</p>}
            {lines.map((item) => (
              <div key={item.id} className="flex gap-3" data-testid={`cart-line-${item.product_id}`}>
                {item.publicProductId && <ProductArt product={item.publicProductId} className="w-16 h-16 rounded-lg flex-none" />}
                <div className="flex-1">
                  <div className="flex justify-between text-sm font-medium">
                    <span>{item.publicProductId?.name}</span>
                    <span>{money(Number(item.publicProductId?.price ?? 0) * 100 * item.quantity)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <button className="btn-icon ring-1 ring-stone-200" aria-label="One less" onClick={() => change.mutate({ id: item.id, quantity: item.quantity - 1 })}><Minus size={12} /></button>
                    <span className="text-sm w-6 text-center" data-testid="cart-qty">{item.quantity}</span>
                    <button className="btn-icon ring-1 ring-stone-200" aria-label="One more" onClick={() => change.mutate({ id: item.id, quantity: item.quantity + 1 })}><Plus size={12} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-stone-200 px-6 py-4 flex flex-col gap-3">
            <input className="input" placeholder="A note for the order (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} data-testid="order-note" />
            <div className="flex justify-between font-medium">
              <span>Total</span>
              <span data-testid="cart-total">{money(total)}</span>
            </div>
            <p className="text-xs text-stone-500">Prices and stock are checked by the database when you order.</p>
            {error && <p className="text-sm text-red-600" data-testid="checkout-error">{error}</p>}
            <button className="btn btn-primary justify-center py-3" disabled={lines.length === 0 || checkout.isPending} onClick={() => checkout.mutate()} data-testid="checkout">
              Place order
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
