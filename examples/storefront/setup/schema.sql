-- Storefront schema. Applied by setup.mjs through the control plane's DDL
-- endpoint; safe to run on a fresh project only (it creates, it never drops).

CREATE TABLE categories (
  id    serial PRIMARY KEY,
  name  text NOT NULL,
  slug  text NOT NULL UNIQUE
);

CREATE TABLE products (
  id           serial PRIMARY KEY,
  category_id  integer NOT NULL REFERENCES categories(id),
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  price        numeric(10,2) NOT NULL CHECK (price >= 0),
  stock        integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  image_url    text,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A signed-in customer's cart lives in the database, one row per product.
CREATE TABLE cart_items (
  id           serial PRIMARY KEY,
  customer_id  text NOT NULL,
  product_id   integer NOT NULL REFERENCES products(id),
  quantity     integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  UNIQUE (customer_id, product_id)
);

CREATE TABLE orders (
  id              serial PRIMARY KEY,
  customer_id     text NOT NULL,
  customer_email  text,
  note            text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'placed'
                  CHECK (status IN ('placed', 'packed', 'shipped', 'delivered', 'cancelled')),
  total           numeric(10,2) NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id           serial PRIMARY KEY,
  order_id     integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   integer NOT NULL REFERENCES products(id),
  customer_id  text NOT NULL,
  quantity     integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  unit_price   numeric(10,2) NOT NULL DEFAULT 0
);

CREATE INDEX order_items_order_id ON order_items(order_id);
CREATE INDEX orders_customer_id ON orders(customer_id);

-- Prices and stock are the database's business, not the browser's: a line
-- item goes only into an open order of the same customer, takes the product's
-- current price, and an order that would oversell fails as a whole.
CREATE FUNCTION order_items_price_and_stock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  left_in_stock integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM orders WHERE id = NEW.order_id AND customer_id = NEW.customer_id AND status = 'placed') THEN
    RAISE EXCEPTION 'order % is not an open order of this customer', NEW.order_id;
  END IF;
  SELECT price, stock INTO NEW.unit_price, left_in_stock FROM products WHERE id = NEW.product_id AND active FOR UPDATE;
  IF NEW.unit_price IS NULL THEN
    RAISE EXCEPTION 'product % is not for sale', NEW.product_id;
  END IF;
  IF left_in_stock < NEW.quantity THEN
    RAISE EXCEPTION 'only % left of product %', left_in_stock, NEW.product_id;
  END IF;
  UPDATE products SET stock = stock - NEW.quantity WHERE id = NEW.product_id;
  RETURN NEW;
END $$;

CREATE TRIGGER order_items_price_and_stock BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_price_and_stock();

CREATE FUNCTION order_items_total() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE orders SET total = total + NEW.unit_price * NEW.quantity WHERE id = NEW.order_id;
  RETURN NULL;
END $$;

CREATE TRIGGER order_items_total AFTER INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_total();

-- Tracked as a query: callable by every role that may read products, and
-- its rows pass through the caller's select permission on products.
CREATE FUNCTION best_sellers(top integer DEFAULT 4) RETURNS SETOF products
LANGUAGE sql STABLE AS $$
  SELECT p.*
  FROM products p
  LEFT JOIN order_items oi ON oi.product_id = p.id
  GROUP BY p.id
  ORDER BY coalesce(sum(oi.quantity), 0) DESC, p.id
  LIMIT top
$$;

INSERT INTO categories (name, slug) VALUES
  ('Desk', 'desk'),
  ('Coffee', 'coffee'),
  ('Carry', 'carry');

INSERT INTO products (category_id, name, description, price, stock, image_url) VALUES
  (1, 'Walnut desk lamp', 'Warm 2700K light on a solid walnut arm. Dimmable, USB-C powered.', 89.00, 14, '/products/lamp.svg'),
  (1, 'Felt desk mat', 'Merino felt, 90 x 40 cm. Quiet mouse, warm wrists.', 39.00, 40, '/products/mat.svg'),
  (1, 'Brass pen', 'Machined brass, refillable, gets better with age.', 29.00, 25, '/products/pen.svg'),
  (2, 'Pour-over kettle', 'Gooseneck, 0.9 L, holds temperature to the degree.', 119.00, 8, '/products/kettle.svg'),
  (2, 'Ceramic mug', 'Hand-glazed stoneware, 350 ml. Every one slightly different.', 24.00, 60, '/products/mug.svg'),
  (2, 'House blend, 250 g', 'Medium roast: cocoa, hazelnut, a little cherry.', 16.00, 120, '/products/beans.svg'),
  (3, 'Canvas tote', 'Heavy waxed canvas with a leather strap.', 49.00, 30, '/products/tote.svg'),
  (3, 'Laptop sleeve', 'Wool felt with a magnetic flap, fits 14 inches.', 59.00, 18, '/products/sleeve.svg');

-- A product that is not on sale: only staff see it.
INSERT INTO products (category_id, name, description, price, stock, image_url, active) VALUES
  (1, 'Prototype monitor stand', 'Not released yet.', 149.00, 3, '/products/stand.svg', false);
