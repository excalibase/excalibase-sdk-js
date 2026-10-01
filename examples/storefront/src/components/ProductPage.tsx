import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Lock } from "lucide-react";
import { useSession } from "../hooks/session";
import { money } from "../lib/money";
import { addToCart, cart, catalog, messageOf } from "../lib/store";
import { recordView } from "../lib/trending";
import { ProductArt } from "./ProductCard";

export function ProductPage({
  productId,
  onBack,
  onSignIn,
  onAdded,
}: {
  productId: number;
  onBack: () => void;
  onSignIn: () => void;
  onAdded: () => void;
}) {
  const { db, role } = useSession();
  const queryClient = useQueryClient();
  const shop = useQuery({ queryKey: ["catalog", role], queryFn: () => catalog(db) });
  const items = useQuery({ queryKey: ["cart", role], queryFn: () => cart(db), enabled: role === "user" });
  const [error, setError] = useState<string | null>(null);
  const product = shop.data?.products.find((candidate) => candidate.id === productId);

  useEffect(() => {
    void recordView(productId).then(() => queryClient.invalidateQueries({ queryKey: ["trending"] }));
  }, [productId, queryClient]);

  const add = useMutation({
    mutationFn: () => addToCart(db, productId, items.data ?? []),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["cart"] });
      onAdded();
    },
    onError: (err) => setError(messageOf(err)),
  });

  if (!product) {
    return <div className="max-w-6xl mx-auto px-6 py-16 text-stone-500">{shop.isLoading ? "Loading…" : "This product is not available."}</div>;
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <button className="text-sm text-stone-500 hover:text-stone-900 flex items-center gap-1 mb-6" onClick={onBack}>
        <ArrowLeft size={14} /> Back to the shop
      </button>
      <div className="grid md:grid-cols-2 gap-10">
        <ProductArt product={product} className="aspect-square rounded-2xl" />
        <div>
          <h1 className="font-display text-4xl" data-testid="product-name">{product.name}</h1>
          <p className="text-2xl mt-3">{money(product.price, { decimal: true })}</p>
          <p className="text-stone-600 mt-6 leading-relaxed">{product.description}</p>
          <p className="text-sm text-stone-500 mt-4" data-testid="product-stock">{product.stock > 0 ? `${product.stock} in stock` : "Sold out"}</p>
          <div className="mt-8">
            {role === "user" ? (
              <button className="btn btn-primary text-base px-6 py-3" disabled={add.isPending || product.stock === 0} onClick={() => add.mutate()} data-testid="add-to-cart">
                Add to cart
              </button>
            ) : role === "anon" ? (
              <button className="btn text-base px-6 py-3" onClick={onSignIn} data-testid="sign-in-to-buy">
                <Lock size={16} /> Sign in to buy
              </button>
            ) : (
              <p className="text-sm text-stone-500">Staff accounts manage the shop; sign in as a customer to buy.</p>
            )}
            {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
