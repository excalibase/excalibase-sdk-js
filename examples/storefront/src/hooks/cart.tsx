import { createContext, useContext, useState, type ReactNode } from "react";

export interface CartItem {
  variantId: number;
  productId: number;
  productName: string;
  sku: string;
  color: string | null;
  price: number;
  quantity: number;
}

interface CartCtx {
  items: CartItem[];
  totalCents: number;
  totalItems: number;
  add: (item: Omit<CartItem, "quantity">) => void;
  remove: (variantId: number) => void;
  setQty: (variantId: number, qty: number) => void;
  clear: () => void;
}

const Ctx = createContext<CartCtx | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);

  const totalCents = items.reduce((s, i) => s + Math.round(i.price * 100) * i.quantity, 0);
  const totalItems = items.reduce((s, i) => s + i.quantity, 0);

  function add(next: Omit<CartItem, "quantity">) {
    setItems(prev => {
      const existing = prev.find(p => p.variantId === next.variantId);
      if (existing) {
        return prev.map(p =>
          p.variantId === next.variantId ? { ...p, quantity: p.quantity + 1 } : p
        );
      }
      return [...prev, { ...next, quantity: 1 }];
    });
  }
  function remove(variantId: number) {
    setItems(prev => prev.filter(i => i.variantId !== variantId));
  }
  function setQty(variantId: number, qty: number) {
    if (qty <= 0) return remove(variantId);
    setItems(prev =>
      prev.map(i => (i.variantId === variantId ? { ...i, quantity: qty } : i))
    );
  }
  function clear() {
    setItems([]);
  }

  return (
    <Ctx.Provider value={{ items, totalCents, totalItems, add, remove, setQty, clear }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCart() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCart must be inside CartProvider");
  return ctx;
}
