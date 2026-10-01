import { useQuery } from "@tanstack/react-query";
import { LogOut, Package, ShieldCheck, ShoppingBag, Trees } from "lucide-react";
import type { View } from "../App";
import { useSession } from "../hooks/session";
import { cart } from "../lib/store";

export function Header({
  view,
  onNavigate,
  onCartOpen,
  onSignIn,
}: {
  view: View;
  onNavigate: (next: View) => void;
  onCartOpen: () => void;
  onSignIn: () => void;
}) {
  const { db, role, email, signOut } = useSession();
  const signedIn = role !== "anon";
  const items = useQuery({ queryKey: ["cart", role], queryFn: () => cart(db), enabled: role === "user" });
  const count = (items.data ?? []).reduce((sum, item) => sum + item.quantity, 0);

  return (
    <header className="bg-white/90 backdrop-blur border-b border-stone-200 sticky top-0 z-30">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center gap-6">
        <button onClick={() => onNavigate({ kind: "catalog", categoryId: null })} className="flex items-center gap-2" data-testid="home">
          <span className="w-9 h-9 rounded-full bg-moss-600 text-white grid place-items-center"><Trees size={18} /></span>
          <span className="font-display text-xl tracking-tight">Larch &amp; Co.</span>
        </button>
        <nav className="flex items-center gap-1 text-sm">
          <Tab active={view.kind === "catalog" || view.kind === "product"} onClick={() => onNavigate({ kind: "catalog", categoryId: null })}>Shop</Tab>
          {role === "user" && (
            <Tab active={view.kind === "orders"} onClick={() => onNavigate({ kind: "orders" })} testId="nav-orders">
              <Package size={14} /> My orders
            </Tab>
          )}
          {role === "staff" && (
            <Tab active={view.kind === "staff"} onClick={() => onNavigate({ kind: "staff" })} testId="nav-staff">
              <ShieldCheck size={14} /> Staff
            </Tab>
          )}
        </nav>
        <div className="flex-1" />
        <RoleBadge role={role} email={email} />
        {signedIn ? (
          <>
            {role === "user" && <button className="btn-icon relative" onClick={onCartOpen} aria-label="Cart" data-testid="cart-button">
              <ShoppingBag size={20} />
              {count > 0 && (
                <span data-testid="cart-count" className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold grid place-items-center">
                  {count}
                </span>
              )}
            </button>}
            <button className="btn-icon" onClick={() => void signOut()} aria-label="Sign out" data-testid="sign-out">
              <LogOut size={18} />
            </button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={onSignIn} data-testid="sign-in">Sign in</button>
        )}
      </div>
    </header>
  );
}

function Tab({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full transition ${active ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100"}`}
    >
      {children}
    </button>
  );
}

const ROLE_STYLE: Record<string, string> = {
  anon: "bg-stone-100 text-stone-600 ring-stone-200",
  user: "bg-sky-50 text-sky-800 ring-sky-200",
  staff: "bg-amber-50 text-amber-800 ring-amber-200",
};

export function RoleBadge({ role, email }: { role: string; email: string | null }) {
  return (
    <div data-testid="role-badge" data-role={role} className={`hidden md:flex items-center gap-2 rounded-full px-3 py-1 text-xs ring-1 ${ROLE_STYLE[role] ?? ROLE_STYLE.user}`}>
      <span className="font-medium">{email ?? "Guest"}</span>
      <span className="font-mono opacity-75">role: {role}</span>
    </div>
  );
}
