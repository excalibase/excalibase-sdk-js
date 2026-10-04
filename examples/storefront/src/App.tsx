import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CartDrawer } from "./components/CartDrawer";
import { Catalog } from "./components/Catalog";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { OrdersPage } from "./components/OrdersPage";
import { ProductPage } from "./components/ProductPage";
import { SignInDialog } from "./components/SignInDialog";
import { StaffPage } from "./components/StaffPage";
import { Toasts, useToasts } from "./components/Toasts";
import { useSession } from "./hooks/session";
import { watchOrders } from "./lib/realtime";

export type View =
  | { kind: "catalog"; categoryId: number | null }
  | { kind: "product"; id: number }
  | { kind: "orders" }
  | { kind: "staff" };

export default function App() {
  const { db, role, session } = useSession();
  const queryClient = useQueryClient();
  const toasts = useToasts();
  const [view, setView] = useState<View>({ kind: "catalog", categoryId: null });
  const [cartOpen, setCartOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const token = session?.accessToken ?? null;

  // Every role refetches everything when the caller changes: what the same
  // queries return depends on who asks.
  useEffect(() => {
    void queryClient.invalidateQueries();
    if (role === "anon" && view.kind !== "catalog" && view.kind !== "product") setView({ kind: "catalog", categoryId: null });
    if (role !== "staff" && view.kind === "staff") setView({ kind: "catalog", categoryId: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Live order updates for signed-in callers (anon has no orders permission,
  // so the engine would refuse the subscription).
  useEffect(() => {
    if (!token) return undefined;
    return watchOrders(db, (change) => {
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      if (change.operation === "UPDATE" && change.row.status) {
        toasts.push(`Order #${change.row.id} is now ${change.row.status}`);
      } else if (change.operation === "INSERT" && role === "staff") {
        toasts.push(`New order #${change.row.id}${change.row.customer_email ? ` from ${change.row.customer_email}` : ""}`);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, db]);

  return (
    <div className="min-h-screen flex flex-col">
      <Header view={view} onNavigate={setView} onCartOpen={() => setCartOpen(true)} onSignIn={() => setSignInOpen(true)} />
      <main className="flex-1">
        {view.kind === "catalog" && (
          <Catalog
            categoryId={view.categoryId}
            onCategoryChange={(categoryId) => setView({ kind: "catalog", categoryId })}
            onOpen={(id) => setView({ kind: "product", id })}
          />
        )}
        {view.kind === "product" && (
          <ProductPage
            productId={view.id}
            onBack={() => setView({ kind: "catalog", categoryId: null })}
            onSignIn={() => setSignInOpen(true)}
            onAdded={() => setCartOpen(true)}
          />
        )}
        {view.kind === "orders" && <OrdersPage />}
        {view.kind === "staff" && role === "staff" && <StaffPage />}
      </main>
      <Footer />
      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} onOrdered={() => setView({ kind: "orders" })} />
      <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} />
      <Toasts toasts={toasts.items} />
    </div>
  );
}
