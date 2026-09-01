import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, ShoppingCart, Star, Loader2, AlertCircle } from "lucide-react";
import { getClient, type DemoIdentity } from "../lib/client";
import { PRODUCT_DETAIL } from "../lib/queries";
import { useCart } from "../hooks/cart";

interface Variant {
  id: number;
  sku: string;
  color: string | null;
  size: string | null;
  stock_quantity: number;
  price_override: number | null;
}

interface Review {
  id: number;
  rating: number;
  title: string | null;
  body: string | null;
  customer_id: number;
  created_at: string;
}

interface Product {
  id: number;
  name: string;
  slug: string;
  price: number;
  category_id: number | null;
  status: string;
  metadata: Record<string, unknown> | null;
  shopifyProductVariants: Variant[];
  shopifyReviews: Review[];
}

const GRADIENTS = [
  "from-pink-100 to-purple-200",
  "from-blue-100 to-cyan-200",
  "from-amber-100 to-orange-200",
  "from-emerald-100 to-teal-200",
  "from-violet-100 to-fuchsia-200",
];

export function ProductDetail({
  productId,
  identity,
  onBack,
}: {
  productId: number;
  identity: DemoIdentity;
  onBack: () => void;
}) {
  const cart = useCart();
  const q = useQuery<{ shopifyProducts: Product[] }, Error>({
    queryKey: ["product", identity.key, productId],
    queryFn: async () =>
      (await getClient().graphql.query(PRODUCT_DETAIL, { id: productId })) as {
        shopifyProducts: Product[];
      },
  });

  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(null);

  if (q.isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-12 text-slate-400">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }
  const product = q.data?.shopifyProducts?.[0];
  if (!product) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-12 text-slate-500">
        Product not found.
      </div>
    );
  }

  const variant =
    product.shopifyProductVariants.find(v => v.id === selectedVariantId) ??
    product.shopifyProductVariants[0];
  const ratings = product.shopifyReviews;
  const avg = ratings.length ? ratings.reduce((s, r) => s + r.rating, 0) / ratings.length : null;
  const grad = GRADIENTS[product.id % GRADIENTS.length];

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <button onClick={onBack} className="btn mb-4">
        <ArrowLeft size={14} /> Back to catalog
      </button>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        {/* Image */}
        <div className={`aspect-square rounded-2xl bg-gradient-to-br ${grad} grid place-items-center`}>
          <span className="text-9xl opacity-40">📦</span>
        </div>

        {/* Info */}
        <div>
          <div className="text-xs font-mono text-slate-500 mb-1">PRODUCT-{product.id}</div>
          <h1 className="text-3xl font-bold text-slate-900">{product.name}</h1>
          {avg != null && (
            <div className="flex items-center gap-1 mt-2 text-sm">
              <Star size={14} className="fill-amber-400 text-amber-400" />
              <span className="font-medium">{avg.toFixed(1)}</span>
              <span className="text-slate-400">· {ratings.length} review{ratings.length === 1 ? "" : "s"}</span>
            </div>
          )}

          <div className="mt-6 text-3xl font-bold text-slate-900">
            ${(variant?.price_override ?? product.price).toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </div>

          {/* Variants */}
          {product.shopifyProductVariants.length > 1 && (
            <div className="mt-5">
              <div className="text-xs uppercase tracking-wider text-slate-400 font-semibold mb-2">
                Variant
              </div>
              <div className="flex flex-wrap gap-2">
                {product.shopifyProductVariants.map(v => {
                  const active = v.id === (variant?.id ?? -1);
                  const oos = v.stock_quantity === 0;
                  return (
                    <button
                      key={v.id}
                      disabled={oos}
                      onClick={() => setSelectedVariantId(v.id)}
                      className={
                        "px-3 py-1.5 rounded-md text-sm font-medium ring-1 transition " +
                        (active
                          ? "bg-brand-500 text-white ring-brand-500"
                          : "bg-white text-slate-700 ring-slate-200 hover:ring-slate-300") +
                        (oos ? " opacity-40 cursor-not-allowed line-through" : "")
                      }
                    >
                      {[v.color, v.size].filter(Boolean).join(" / ") || v.sku}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="mt-3 text-xs text-slate-500">
            {variant && variant.stock_quantity > 0
              ? <span className="text-emerald-700"><span className="font-mono">{variant.stock_quantity}</span> in stock · SKU <span className="font-mono">{variant.sku}</span></span>
              : <span className="text-rose-700">Out of stock</span>}
          </div>

          {/* Add to cart / sign-in hint */}
          <div className="mt-6">
            {identity.key === "anon" ? (
              <div className="px-3 py-2.5 rounded-md bg-amber-50 ring-1 ring-amber-200 text-sm text-amber-900 flex items-start gap-2">
                <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                <span>
                  Sign in to add to cart. The active role <span className="font-mono">{identity.pgRole}</span>{" "}
                  has read-only access to the catalog.
                </span>
              </div>
            ) : (
              <button
                disabled={!variant || variant.stock_quantity === 0}
                onClick={() => {
                  if (!variant) return;
                  cart.add({
                    variantId: variant.id,
                    productId: product.id,
                    productName: product.name,
                    sku: variant.sku,
                    color: variant.color,
                    price: Number(variant.price_override ?? product.price),
                  });
                }}
                className="btn btn-primary text-base px-5 py-2.5 w-full max-w-xs"
              >
                <ShoppingCart size={16} /> Add to cart
              </button>
            )}
          </div>

          {/* Metadata as raw chips */}
          {product.metadata && Object.keys(product.metadata).length > 0 && (
            <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              {Object.entries(product.metadata).map(([k, v]) => (
                <div key={k}>
                  <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">{k}</div>
                  <div className="text-slate-700">{String(v)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Reviews */}
      <section className="mt-12">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Reviews</h2>
        {ratings.length === 0 && (
          <p className="text-sm italic text-slate-400">No reviews yet.</p>
        )}
        <div className="space-y-3">
          {ratings.map(r => (
            <article key={r.id} className="bg-white rounded-lg ring-1 ring-slate-100 p-4">
              <div className="flex items-center gap-1 text-amber-400">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} size={14} className={i < r.rating ? "fill-amber-400" : "fill-slate-200 text-slate-200"} />
                ))}
                <span className="ml-2 text-xs text-slate-400">user #{r.customer_id} · {new Date(r.created_at).toLocaleDateString()}</span>
              </div>
              {r.title && <h3 className="font-medium text-slate-800 mt-1.5">{r.title}</h3>}
              {r.body && <p className="text-sm text-slate-700 mt-1 leading-relaxed">{r.body}</p>}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
