import type { Product } from "../lib/types";
import { money } from "../lib/money";
import { useImageUrl } from "../hooks/images";

// The product's picture from the project's Storage, or its name until there is one.
export function ProductArt({ product, className = "" }: { product: Pick<Product, "name" | "image_id">; className?: string }) {
  const src = useImageUrl(product.image_id);
  return (
    <div className={`bg-stone-100 grid place-items-center overflow-hidden ${className}`}>
      {src ? (
        <img src={src} alt={product.name} className="w-full h-full object-cover" data-testid="product-image" />
      ) : (
        <span className="text-stone-400 text-sm">{product.name}</span>
      )}
    </div>
  );
}

export function ProductCard({ product, onOpen, badge }: { product: Product; onOpen: () => void; badge?: string }) {
  return (
    <button onClick={onOpen} data-testid={`product-${product.id}`} className="card text-left overflow-hidden group">
      <div className="relative">
        <ProductArt product={product} className="aspect-[4/3] group-hover:scale-[1.02] transition" />
        {badge && <span className="absolute top-3 left-3 pill bg-white/90 text-stone-700">{badge}</span>}
        {!product.active && <span className="absolute top-3 right-3 pill bg-amber-100 text-amber-800">Not on sale</span>}
      </div>
      <div className="p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-medium text-stone-900">{product.name}</h3>
          <span className="text-stone-900 font-semibold">{money(product.price, { decimal: true })}</span>
        </div>
        <p className="text-sm text-stone-500 mt-1 line-clamp-2">{product.description}</p>
        {product.stock <= 5 && product.stock > 0 && <p className="text-xs text-amber-700 mt-2">Only {product.stock} left</p>}
        {product.stock === 0 && <p className="text-xs text-red-600 mt-2">Sold out</p>}
      </div>
    </button>
  );
}
