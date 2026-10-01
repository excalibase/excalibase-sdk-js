import { useQuery } from "@tanstack/react-query";
import { Flame, Sparkles } from "lucide-react";
import { useSession } from "../hooks/session";
import { bestSellers, catalog } from "../lib/store";
import { trending } from "../lib/trending";
import type { Product } from "../lib/types";
import { ProductCard } from "./ProductCard";

export function Catalog({
  categoryId,
  onCategoryChange,
  onOpen,
}: {
  categoryId: number | null;
  onCategoryChange: (categoryId: number | null) => void;
  onOpen: (id: number) => void;
}) {
  const { db, role } = useSession();
  const shop = useQuery({ queryKey: ["catalog", role], queryFn: () => catalog(db) });
  const best = useQuery({ queryKey: ["best-sellers", role], queryFn: () => bestSellers(db, 4) });
  const views = useQuery({ queryKey: ["trending"], queryFn: () => trending(4), refetchInterval: 10_000 });

  const products = shop.data?.products ?? [];
  const byId = new Map(products.map((product) => [product.id, product]));
  const hot = (views.data ?? []).map((entry) => byId.get(entry.productId)).filter((p): p is Product => Boolean(p));
  const shown = categoryId == null ? products : products.filter((product) => product.category_id === categoryId);

  return (
    <div className="max-w-6xl mx-auto px-6 pb-16">
      <section className="py-12">
        <p className="text-sm uppercase tracking-widest text-moss-700">Small goods, made to last</p>
        <h1 className="font-display text-5xl mt-2 max-w-2xl leading-tight">Things for the desk, the kettle and the walk home.</h1>
      </section>

      {shop.isError && <p className="text-red-600" data-testid="catalog-error">The catalog could not be loaded.</p>}

      {(best.data?.length ?? 0) > 0 && (
        <Row title="Best sellers" icon={<Sparkles size={16} />} caption="ranked by the database function best_sellers()" testId="best-sellers">
          {best.data!.map((product) => <ProductCard key={product.id} product={product} onOpen={() => onOpen(product.id)} />)}
        </Row>
      )}

      {hot.length > 0 && (
        <Row title="Trending now" icon={<Flame size={16} />} caption="product views counted in the store's private Redis" testId="trending">
          {hot.map((product) => (
            <ProductCard key={product.id} product={product} onOpen={() => onOpen(product.id)}
              badge={`${views.data!.find((entry) => entry.productId === product.id)?.views ?? 0} views`} />
          ))}
        </Row>
      )}

      <div className="flex items-center gap-2 mt-10 mb-4" data-testid="categories">
        <Chip active={categoryId == null} onClick={() => onCategoryChange(null)}>All</Chip>
        {(shop.data?.categories ?? []).map((category) => (
          <Chip key={category.id} active={categoryId === category.id} onClick={() => onCategoryChange(category.id)}>{category.name}</Chip>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5" data-testid="product-grid">
        {shown.map((product) => <ProductCard key={product.id} product={product} onOpen={() => onOpen(product.id)} />)}
      </div>
    </div>
  );
}

function Row({ title, icon, caption, testId, children }: { title: string; icon: React.ReactNode; caption: string; testId: string; children: React.ReactNode }) {
  return (
    <section className="mt-8" data-testid={testId}>
      <div className="flex items-baseline gap-3 mb-4">
        <h2 className="font-display text-2xl flex items-center gap-2">{icon}{title}</h2>
        <span className="text-xs text-stone-400">{caption}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">{children}</div>
    </section>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`px-4 py-1.5 rounded-full text-sm ring-1 transition ${active ? "bg-stone-900 text-white ring-stone-900" : "bg-white text-stone-700 ring-stone-200 hover:ring-stone-400"}`}>
      {children}
    </button>
  );
}
