export interface Category {
  id: number;
  name: string;
  slug: string;
}

export interface Product {
  id: number;
  category_id: number;
  name: string;
  description: string;
  price: string | number;
  stock: number;
  // A storage id in the project's Storage; images.urls turns it into a link.
  image_id: string | null;
  active: boolean;
}

export interface CartItem {
  id: number;
  product_id: number;
  quantity: number;
  // Forward relationships are named after the foreign key column.
  publicProductId: Product | null;
}

export type OrderStatus = "placed" | "packed" | "shipped" | "delivered" | "cancelled";

export interface OrderItem {
  id: number;
  quantity: number;
  unit_price: string | number;
  publicProductId: Pick<Product, "id" | "name" | "image_id"> | null;
}

export interface Order {
  id: number;
  status: OrderStatus;
  total: string | number;
  note: string;
  created_at: string;
  customer_email?: string | null;
  publicOrderItems: OrderItem[];
}

export const ORDER_STATUSES: OrderStatus[] = ["placed", "packed", "shipped", "delivered", "cancelled"];
