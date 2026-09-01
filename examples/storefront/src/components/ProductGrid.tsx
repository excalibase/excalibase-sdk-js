import { useQuery } from "@tanstack/react-query";
import { Loader2, Star } from "lucide-react";
import { getClient, type DemoIdentity } from "../lib/client";
import { productsQuery } from "../lib/queries";

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
  slug: string;
  price: number;
  category_id: number | null;
  status: string;
  shopifyProductVariants: Variant[];
  shopifyReviews: Array<{ id: number; rating: number }>;
}

interface Category {
  id: number;
  name: string;
  slug: string;
}

interface Response {
  shopifyProducts: Product[];
  shopifyCategories: Category[];
}

const PRODUCT_GRADIENTS = [
  "from-pink-100 to-purple-100",
  "from-blue-100 to-cyan-100",
  "from-amber-100 to-orange-100",
  "from-emerald-100 to-teal-100",
  "from-violet-100 to-fuchsia-100",
  "from-rose-100 to-red-100",
  "from-sky-100 to-indigo-100",
];

function gradientFor(id: number) {
  return PRODUCT_GRADIENTS[id % PRODUCT_GRADIENTS.length];
}

export function ProductGrid({
  identity,
  categoryId,
  onCategoryChange,
  onProductClick,
}: {
  identity: DemoIdentity;
  categoryId: number | null;
  onCategoryChange: (id: number | null) => void;
  onProductClick: (id: number) => void;
}) {
  const q = useQuery<Response, Error>({
    queryKey: ["products", identity.key, categoryId],
    queryFn: async () => (await getClient().graphql.query(productsQuery(categoryId))) as Response,
  });

  const products = q.data?.shopifyProducts ?? [];
  const categories = q.data?.shopifyCategories ?? [];

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Hero */}
      <section className="rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 text-white p-10 mb-10 relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.15),transparent_60%)]" />
        <div className="relative">
          <div className="text-xs font-mono text-brand-100 mb-2">
            Excalibase Storefront · live RLS demo
          </div>
          <h1 className="text-3xl md:text-4xl font-bold leading-tight max-w-2xl">
            Catalog browse, customer cart, admin inventory — same database, three different roles.
          </h1>
          <p className="text-brand-100 text-sm mt-3 max-w-xl">
            The product list below is the same query for every visitor — what differs is what
            <span className="font-mono px-1.5 py-0.5 bg-white/10 rounded mx-1">SET LOCAL ROLE</span>
            unlocks. Switch the identity in the top-right to see RLS in action.
          </p>
        </div>
      </section>

      {/* Category filters */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <button
          onClick={() => onCategoryChange(null)}
          className={
            "px-3 py-1.5 rounded-full text-sm font-medium transition " +
            (categoryId == null
              ? "bg-slate-900 text-white"
              : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-slate-300")
          }
        >
          All
        </button>
        {categories.map(c => (
          <button
            key={c.id}
            onClick={() => onCategoryChange(c.id)}
            className={
              "px-3 py-1.5 rounded-full text-sm font-medium transition " +
              (categoryId === c.id
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-slate-300")
            }
          >
            {c.name}
          </button>
        ))}
        {q.isFetching && (
          <Loader2 size={14} className="animate-spin text-slate-400 ml-2" />
        )}
      </div>

      {/* Grid */}
      {q.error && (
        <div className="bg-red-50 ring-1 ring-red-200 rounded-lg p-4 text-sm text-red-700">
          <span className="font-mono">{q.error.message.split("\n")[0].slice(0, 280)}</span>
        </div>
      )}

      {!q.error && products.length === 0 && !q.isLoading && (
        <div className="text-center py-12 text-slate-400">No products found.</div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
        {products.map(p => (
          <ProductCard
            key={p.id}
            product={p}
            onClick={() => onProductClick(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ProductCard({ product, onClick }: { product: Product; onClick: () => void }) {
  const minStock = Math.min(...(product.shopifyProductVariants ?? []).map(v => v.stock_quantity), Infinity);
  const inStock = isFinite(minStock) ? minStock > 0 : true;
  const ratings = product.shopifyReviews ?? [];
  const avgRating = ratings.length
    ? ratings.reduce((s, r) => s + r.rating, 0) / ratings.length
    : null;

  return (
    <button
      onClick={onClick}
      className="group text-left bg-white rounded-xl ring-1 ring-slate-100 overflow-hidden transition hover:ring-slate-200 hover:shadow-card-hover"
    >
      <div
        className={
          "aspect-[4/3] bg-gradient-to-br relative " + gradientFor(product.id)
        }
      >
        <div className="absolute inset-0 grid place-items-center text-7xl opacity-30 group-hover:scale-105 transition">
          📦
        </div>
        {!inStock && (
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-bold bg-slate-900 text-white">
            OUT OF STOCK
          </div>
        )}
      </div>
      <div className="p-3">
        <h3 className="text-sm font-medium text-slate-900 truncate group-hover:text-brand-700 transition">
          {product.name}
        </h3>
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-base font-bold text-slate-900">
            ${product.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          {avgRating != null && (
            <span className="flex items-center gap-0.5 text-xs text-slate-500">
              <Star size={12} className="fill-amber-400 text-amber-400" />
              {avgRating.toFixed(1)}
              <span className="text-slate-300">({ratings.length})</span>
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
