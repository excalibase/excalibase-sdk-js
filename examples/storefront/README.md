# `@excalibase/sdk` — Storefront Demo

Shopify-style storefront on the ecommerce schema, demonstrating
`@excalibase/sdk` with full Postgres role switching + RLS. Anyone can
browse the catalog; signing in unlocks the cart and "My orders"; the
admin role gets an inventory editor.

| Identity | Catalog | Cart / checkout | My orders | Admin inventory |
|---|---|---|---|---|
| Guest (anon) | ✓ | "no INSERT grant" hint | — | — |
| Alice / Carol | ✓ | ✓ — own customer_id only | ✓ — RLS-filtered to own | — |
| Inventory admin | ✓ | ✓ | sees ALL customers' orders | ✓ — `PATCH /product_variants` |

The footer pill shows the **resolved Postgres role** from a live
`SELECT current_user FROM shopify.whoami_view` round-trip.

## What's in here

| File | Role |
|---|---|
| `src/App.tsx` | Top-level routing (`catalog / product / orders / admin`) + identity handler |
| `src/lib/client.ts` | SDK wiring + four demo identities (projectId="shopify") |
| `src/lib/queries.ts` | GraphQL documents (products, my orders, admin orders, whoami) |
| `src/hooks/cart.tsx` | In-memory cart context |
| `src/components/Header.tsx` | Logo, nav, search, cart, identity dropdown |
| `src/components/ProductGrid.tsx` | Hero + category filter + product grid |
| `src/components/ProductDetail.tsx` | Variant picker, reviews, add-to-cart (auth-gated) |
| `src/components/CartDrawer.tsx` | Slide-in cart, checkout via `POST /orders` + `/order_items` |
| `src/components/OrdersPanel.tsx` | "My orders" — RLS-filtered list per customer |
| `src/components/AdminPanel.tsx` | Inventory editor + cross-customer order list |
| `src/components/Footer.tsx` | Live `whoami_view` role pill |
| `scripts/sign-tokens.mjs` | Signs the four demo JWTs (projectId="shopify") |

## Setup

This demo expects `excalibase-graphql` checked out next to
`excalibase-sdk-js`. The graphql repo provides the docker stack, RLS
policies (`init-shopify-rls.sql`), and the test JWT signing key.

```bash
# In excalibase-graphql:
make demo-shop
# stack up + tokens signed + Vite dev server at http://localhost:5176
```

Step by step:

```bash
cd ~/Documents/duk/excalibase-graphql
make demo-up

cd ~/Documents/duk/excalibase-sdk-js/examples/storefront
npm install
npm run sign-tokens
npm run dev
# → http://localhost:5176
```

## What to look at

1. **Browse as guest** — full product grid renders with reviews +
   ratings. Click any product → variant picker, reviews — but the
   add-to-cart button is replaced by an inline RLS-explanation hint.

2. **Switch to Alice Chen** — add-to-cart unlocks. Add a couple of
   items, click the cart icon (top right), watch the cart slide in.
   Hit "Checkout as Alice Chen" — `POST /orders` with
   `customer_id = (request.user_id)` succeeds because RLS WITH CHECK
   matches.

3. **Click "My orders"** — see only Alice's orders. Switch to Carol —
   the list changes; she sees only HER orders (server-filtered, not a
   client query change).

4. **Try a write that should fail** — open browser devtools and POST
   `/orders` with `customer_id: 99` while signed in as Alice. The RLS
   `WITH CHECK` rejects the row.

5. **Switch to Inventory admin** — the "Admin" tab appears. Edit a
   stock quantity → `PATCH /product_variants` succeeds because the
   admin role has full RW. The "All orders (cross-customer)" tab shows
   every customer's orders — admin policy `FOR ALL ... USING (true)`.

6. **Watch the footer** — pill flips between `app_anon` (gray),
   `app_authenticated` (blue), `app_admin` (red).

## Troubleshooting

**`Could not read demo signing key`** — set `EXCALIBASE_DEMO_KEY` or
check out `excalibase-graphql` next to `excalibase-sdk-js`.

**Catalog empty / "permission denied"** — the shopify-rls init script
might not have run. Re-deploy with a clean volume:
```bash
cd ~/Documents/duk/excalibase-graphql
docker compose -f e2e/study-cases/docker-compose.study-cases.yml down -v sc-shopify-postgres
make demo-up
```

**Checkout fails for Alice** — the customer row alignment between JWT
`userId` and `shopify.customers.id` may have drifted. Verify in
`init-shopify-rls.sql` that customers 1, 2, 3 are seeded with explicit
IDs matching the demo's userIds.

## Companion

`examples/jira-board` is the same SDK + role-switching pattern, but on
the kanban schema shaped like Jira/Linear — drag-drop board, issue
detail drawer, comment threads.
