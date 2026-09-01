import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Search, ShoppingCart, Package, ShieldCheck, ChevronDown, Store } from "lucide-react";
import { IDENTITIES, type DemoIdentity } from "../lib/client";
import { useCart } from "../hooks/cart";
import type { View } from "../App";

export function Header({
  identity,
  view,
  onIdentityChange,
  onNavigate,
  onCartOpen,
}: {
  identity: DemoIdentity;
  view: View;
  onIdentityChange: (next: DemoIdentity) => void;
  onNavigate: (next: View) => void;
  onCartOpen: () => void;
}) {
  const cart = useCart();
  const isAdmin = identity.pgRole === "app_admin";
  const isAuth = identity.key !== "anon";

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-6 h-14 flex items-center gap-6">
        {/* Logo */}
        <button
          onClick={() => onNavigate({ kind: "catalog", categoryId: null })}
          className="flex items-center gap-2 group"
        >
          <div className="w-8 h-8 rounded-lg bg-brand-500 grid place-items-center text-white">
            <Store size={16} />
          </div>
          <span className="font-bold text-lg text-slate-900 group-hover:text-brand-700 transition">
            Excalibase Shop
          </span>
        </button>

        {/* Nav */}
        <nav className="flex items-center gap-1">
          <NavButton
            active={view.kind === "catalog"}
            onClick={() => onNavigate({ kind: "catalog", categoryId: null })}
          >
            Catalog
          </NavButton>
          {isAuth && (
            <NavButton
              active={view.kind === "orders"}
              onClick={() => onNavigate({ kind: "orders" })}
              icon={<Package size={14} />}
            >
              My orders
            </NavButton>
          )}
          {isAdmin && (
            <NavButton
              active={view.kind === "admin"}
              onClick={() => onNavigate({ kind: "admin" })}
              icon={<ShieldCheck size={14} />}
            >
              Admin
            </NavButton>
          )}
        </nav>

        {/* Search */}
        <div className="flex-1 max-w-sm relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            placeholder="Search products"
            className="w-full pl-9 pr-3 py-1.5 rounded-md text-sm bg-slate-100 border border-transparent
                       focus:bg-white focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none transition"
          />
        </div>

        {/* Cart + identity */}
        <div className="flex items-center gap-2">
          <button
            onClick={onCartOpen}
            className="relative btn-icon"
            aria-label="Open cart"
          >
            <ShoppingCart size={18} />
            {cart.totalItems > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-brand-500 text-white text-[10px] font-bold grid place-items-center">
                {cart.totalItems}
              </span>
            )}
          </button>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-md hover:bg-slate-100 transition">
                <span className={`avatar w-7 h-7 ${identity.tint}`}>{identity.initials}</span>
                <span className="text-sm font-medium text-slate-700">{identity.label}</span>
                <ChevronDown size={14} className="text-slate-400" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="min-w-72 bg-white rounded-lg shadow-lg ring-1 ring-slate-200 p-1.5 z-50"
              >
                <DropdownMenu.Label className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
                  Switch identity
                </DropdownMenu.Label>
                {IDENTITIES.map(id => (
                  <DropdownMenu.Item
                    key={id.key}
                    onSelect={() => onIdentityChange(id)}
                    className={
                      "flex items-start gap-2.5 px-2 py-1.5 rounded text-sm cursor-pointer transition outline-none " +
                      (id.key === identity.key
                        ? "bg-brand-50 text-brand-700"
                        : "text-slate-700 hover:bg-slate-50 focus:bg-slate-50")
                    }
                  >
                    <span className={`avatar w-7 h-7 mt-0.5 flex-shrink-0 ${id.tint}`}>
                      {id.initials}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium leading-tight">{id.label}</div>
                      <div className="text-xs text-slate-500 leading-tight mt-0.5">
                        {id.blurb}
                      </div>
                      <div className="text-[10px] font-mono text-slate-400 mt-1">
                        role: {id.pgRole}
                      </div>
                    </div>
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
    </header>
  );
}

function NavButton({
  active,
  onClick,
  children,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition " +
        (active
          ? "bg-brand-50 text-brand-700"
          : "text-slate-600 hover:text-slate-900 hover:bg-slate-50")
      }
    >
      {icon}
      {children}
    </button>
  );
}
