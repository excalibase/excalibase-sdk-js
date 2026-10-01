// Every read and write the store makes, as GraphQL against the project. The
// same documents run for every role; the project's permissions decide what
// each role gets back (or whether the field exists for it at all).
import type { DbClient } from "@excalibase/sdk";
import { decimal, int, str } from "./gql";
import type { CartItem, Category, Order, OrderStatus, Product } from "./types";

const PRODUCT_FIELDS = "id category_id name description price stock image_url active";
const ORDER_FIELDS = `id status total note created_at
  publicOrderItems(orderBy: { id: ASC }) { id quantity unit_price publicProductId { id name image_url } }`;

export async function catalog(db: DbClient): Promise<{ categories: Category[]; products: Product[] }> {
  const data = await db.graphql.query<{ publicCategories: Category[]; publicProducts: Product[] }>(`{
    publicCategories(orderBy: { id: ASC }) { id name slug }
    publicProducts(orderBy: { id: ASC }) { ${PRODUCT_FIELDS} }
  }`);
  return { categories: data.publicCategories, products: data.publicProducts };
}

// The tracked function best_sellers(top): ranked in the database, its rows
// filtered by the caller's own products permission.
export async function bestSellers(db: DbClient, top: number): Promise<Product[]> {
  const data = await db.graphql.query<{ publicBestSellers: Product[] }>(
    `{ publicBestSellers(top: ${int(top)}) { ${PRODUCT_FIELDS} } }`,
  );
  return data.publicBestSellers;
}

export async function cart(db: DbClient): Promise<CartItem[]> {
  const data = await db.graphql.query<{ publicCartItems: CartItem[] }>(`{
    publicCartItems(orderBy: { id: ASC }) { id product_id quantity publicProductId { ${PRODUCT_FIELDS} } }
  }`);
  return data.publicCartItems;
}

// customer_id is never sent: the permission presets it from the token.
export async function addToCart(db: DbClient, productId: number, current: CartItem[]): Promise<void> {
  const existing = current.find((item) => item.product_id === productId);
  if (existing) {
    await setQuantity(db, existing.id, existing.quantity + 1);
    return;
  }
  await db.graphql.mutation(
    `mutation { createPublicCartItems(input: { product_id: ${int(productId)}, quantity: 1 }) { id } }`,
  );
}

export async function setQuantity(db: DbClient, cartItemId: number, quantity: number): Promise<void> {
  if (quantity <= 0) {
    await removeFromCart(db, [cartItemId]);
    return;
  }
  await db.graphql.mutation(
    `mutation { updatePublicCartItems(where: { id: { eq: ${int(cartItemId)} } }, input: { quantity: ${int(quantity)} }) { id } }`,
  );
}

export async function removeFromCart(db: DbClient, cartItemIds: number[]): Promise<void> {
  if (cartItemIds.length === 0) return;
  await db.graphql.mutation(
    `mutation { deletePublicCartItems(where: { id: { in: [${cartItemIds.map(int).join(", ")}] } }) { id } }`,
  );
}

// One nested insert: the order and its line items in a single mutation. The
// database prices each line, takes stock and totals the order.
export async function placeOrder(db: DbClient, items: CartItem[], note: string): Promise<number> {
  const lines = items
    .map((item) => `{ product_id: ${int(item.product_id)}, quantity: ${int(item.quantity)} }`)
    .join(", ");
  const data = await db.graphql.mutation<{ createPublicOrders: { id: number } }>(`mutation {
    createPublicOrders(input: { note: ${str(note)}, publicOrderItems: { data: [${lines}] } }) { id }
  }`);
  await removeFromCart(db, items.map((item) => item.id));
  return data.createPublicOrders.id;
}

export async function myOrders(db: DbClient): Promise<Order[]> {
  const data = await db.graphql.query<{ publicOrders: Order[] }>(
    `{ publicOrders(orderBy: { id: DESC }) { ${ORDER_FIELDS} } }`,
  );
  return data.publicOrders;
}

export async function allOrders(db: DbClient): Promise<Order[]> {
  const data = await db.graphql.query<{ publicOrders: Order[] }>(
    `{ publicOrders(orderBy: { id: DESC }, limit: 50) { customer_email ${ORDER_FIELDS} } }`,
  );
  return data.publicOrders;
}

export async function setOrderStatus(db: DbClient, orderId: number, status: OrderStatus): Promise<void> {
  await db.graphql.mutation(
    `mutation { updatePublicOrders(where: { id: { eq: ${int(orderId)} } }, input: { status: ${str(status)} }) { id } }`,
  );
}

export interface ProductChange {
  price?: number;
  stock?: number;
  active?: boolean;
}

export async function updateProduct(db: DbClient, productId: number, change: ProductChange): Promise<void> {
  const fields = [
    change.price === undefined ? null : `price: ${decimal(change.price)}`,
    change.stock === undefined ? null : `stock: ${int(change.stock)}`,
    change.active === undefined ? null : `active: ${change.active ? "true" : "false"}`,
  ].filter(Boolean);
  if (fields.length === 0) return;
  await db.graphql.mutation(
    `mutation { updatePublicProducts(where: { id: { eq: ${int(productId)} } }, input: { ${fields.join(", ")} }) { id } }`,
  );
}

export interface NewProduct {
  categoryId: number;
  name: string;
  description: string;
  price: number;
  stock: number;
  imageUrl: string;
}

export async function createProduct(db: DbClient, product: NewProduct): Promise<void> {
  await db.graphql.mutation(`mutation { createPublicProducts(input: {
    category_id: ${int(product.categoryId)}, name: ${str(product.name)}, description: ${str(product.description)},
    price: ${decimal(product.price)}, stock: ${int(product.stock)}, image_url: ${str(product.imageUrl)}, active: true
  }) { id } }`);
}

// The engine's own message, without graphql-request's echo of the request.
export function messageOf(error: unknown): string {
  const response = (error as { cause?: { response?: { errors?: Array<{ message?: string }> } } })?.cause?.response;
  const first = response?.errors?.[0]?.message;
  if (first) return first;
  const message = error instanceof Error ? error.message : String(error);
  return message.split(": {")[0].slice(0, 200);
}
