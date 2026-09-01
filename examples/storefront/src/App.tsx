import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Header } from "./components/Header";
import { ProductGrid } from "./components/ProductGrid";
import { ProductDetail } from "./components/ProductDetail";
import { CartDrawer } from "./components/CartDrawer";
import { OrdersPanel } from "./components/OrdersPanel";
import { AdminPanel } from "./components/AdminPanel";
import { Footer } from "./components/Footer";
import { CartProvider } from "./hooks/cart";
import { IDENTITIES, setIdentity, type DemoIdentity } from "./lib/client";

export type View =
  | { kind: "catalog"; categoryId: number | null }
  | { kind: "product"; id: number }
  | { kind: "orders" }
  | { kind: "admin" };

export default function App() {
  const queryClient = useQueryClient();
  const [identity, setActiveIdentity] = useState<DemoIdentity>(IDENTITIES[0]);
  const [view, setView] = useState<View>({ kind: "catalog", categoryId: null });
  const [cartOpen, setCartOpen] = useState(false);

  function handleIdentityChange(next: DemoIdentity) {
    setIdentity(next);
    setActiveIdentity(next);
    queryClient.invalidateQueries();
    // Anon can't view orders/admin — bounce them to catalog.
    if (next.key === "anon" && (view.kind === "orders" || view.kind === "admin")) {
      setView({ kind: "catalog", categoryId: null });
    }
    // Non-admin can't view admin panel.
    if (next.pgRole !== "app_admin" && view.kind === "admin") {
      setView({ kind: "catalog", categoryId: null });
    }
  }

  useEffect(() => {
    setIdentity(identity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <CartProvider>
      <div className="min-h-screen flex flex-col bg-slate-50">
        <Header
          identity={identity}
          view={view}
          onIdentityChange={handleIdentityChange}
          onNavigate={setView}
          onCartOpen={() => setCartOpen(true)}
        />
        <main className="flex-1">
          {view.kind === "catalog" && (
            <ProductGrid
              identity={identity}
              categoryId={view.categoryId}
              onCategoryChange={cid => setView({ kind: "catalog", categoryId: cid })}
              onProductClick={id => setView({ kind: "product", id })}
            />
          )}
          {view.kind === "product" && (
            <ProductDetail
              productId={view.id}
              identity={identity}
              onBack={() => setView({ kind: "catalog", categoryId: null })}
            />
          )}
          {view.kind === "orders" && (
            <OrdersPanel identity={identity} />
          )}
          {view.kind === "admin" && identity.pgRole === "app_admin" && (
            <AdminPanel identity={identity} />
          )}
        </main>
        <Footer identity={identity} />
        <CartDrawer
          open={cartOpen}
          onClose={() => setCartOpen(false)}
          identity={identity}
        />
      </div>
    </CartProvider>
  );
}
