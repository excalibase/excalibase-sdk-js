// Product views, kept by the store's own server in the project's private
// Redis. The browser never reaches Redis; it calls the server it was served by.
export interface TrendingEntry {
  productId: number;
  views: number;
}

export async function recordView(productId: number): Promise<void> {
  await fetch(`/api/views/${productId}`, { method: "POST" }).catch(() => undefined);
}

export async function trending(limit = 4): Promise<TrendingEntry[] | null> {
  try {
    const response = await fetch(`/api/trending?limit=${limit}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { products: TrendingEntry[] };
    return body.products;
  } catch {
    return null;
  }
}
