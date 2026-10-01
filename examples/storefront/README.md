# Storefront: a small store built on Excalibase

A working shop, "Larch & Co.", that uses an Excalibase project end to end and
runs on the platform's Containers. It is the store shown in the Excalibase demo
videos.

| Who | Sees and does |
|---|---|
| Guest (`anon`, no token) | browses the catalog and the best sellers; no cart, no orders: those tables do not exist for `anon` |
| Customer (`user`, a signed-in account) | a cart and orders that are only their own; places an order with its line items in one mutation; sees its status change live |
| Staff (the custom role `staff`) | every order, with the customer's email; changes order status; edits prices, stock and what is on sale; adds products |

What it uses:

- **API permissions** (one rule per table, role and operation, the Hasura
  model): the same GraphQL documents run for every role and return what that
  role may see. Presets fill `customer_id` and `customer_email` from the token,
  so a customer cannot write rows for someone else.
- **A custom role** given to an account through the project's end-user role
  API (`staff`, allowed to act as `user` too).
- **A nested insert**: an order and its line items in one `createPublicOrders`
  mutation. Database triggers price each line, take stock (an order that would
  oversell fails as a whole) and total the order.
- **A tracked function**: `best_sellers(top)` ranks products by units sold. It
  is `STABLE`, so it is a query every role that reads products may call, and
  its rows pass through the caller's own products permission (guests never see
  a product that is not on sale, even if it sells).
- **Realtime**: `publicOrdersChanges` over the project's GraphQL websocket. A
  customer's order list updates when staff ship the order; staff see new orders
  arrive. Each change reaches only callers whose permission covers the row.
- **End-user auth** through `@excalibase/sdk` (sign up, sign in, session kept
  and refreshed).
- **Containers**: the store's own server runs as an app next to the project,
  and counts product views ("Trending now") in a Redis that only the project's
  apps can reach, over the project's private network.

## Run it on the platform

1. In Studio, open a project with a Postgres database, go to **Containers →
   Templates** and deploy **Storefront demo**. It creates two apps: `storefront`
   (public, on its own URL) and `redis` (internal), and turns on the private
   network. Or through the API:
   `POST /api/projects/{projectId}/app-templates/storefront-demo/deploy` with
   `{"confirmPrivateNetwork": true}`.
2. Run the setup script against the project. It needs a personal access token
   (`excb_…`) of a Developer on the project, made with `POST /api/auth/tokens`
   `{"name": "storefront setup"}` while signed in to the control plane:

   ```bash
   cd examples/storefront && npm ci
   EXCALIBASE_API=https://<studio host>/api \
   EXCALIBASE_TOKEN=<access token> \
   EXCALIBASE_DATA_URL=https://<data plane host> \
   PROJECT_ID=<project id> \
   npm run setup
   ```

   Everything goes through the platform's APIs: the schema and sample products
   (`/api/schema/{id}/ddl`), the permissions and the tracked function
   (`/api/provision/{id}/permissions`, `/tracked-functions`), realtime on
   `orders`, a publishable key, CORS for the store's URL, three demo accounts
   (`alice@` and `bob@` customers, `sam@` staff, under `example.test` unless
   `DEMO_EMAIL_DOMAIN` says otherwise; one password, from `DEMO_PASSWORD` or
   generated and printed), and the store's `EXCALIBASE_*` variables, after which
   the store is redeployed. Running it again is safe: what exists is kept.
   The script also ships in the store's image, so no checkout is needed:
   `docker run --rm -e EXCALIBASE_API=… -e EXCALIBASE_TOKEN=… -e EXCALIBASE_DATA_URL=… -e PROJECT_ID=… <the template's image> node setup/setup.mjs`.
3. Open the store's URL (printed at the end, and shown on the app in Studio).

The permissions are in [`setup/permissions.mjs`](setup/permissions.mjs) and the
schema in [`setup/schema.sql`](setup/schema.sql).

## Run it locally against a project

```bash
cd examples/storefront && npm ci
# CORS: let the dev server's origin call the project
EXTRA_ORIGINS=http://localhost:5176 STOREFRONT_APP=none EXCALIBASE_API=... EXCALIBASE_TOKEN=... \
  EXCALIBASE_DATA_URL=... PROJECT_ID=... npm run setup
VITE_EXCALIBASE_URL=<data plane URL> VITE_EXCALIBASE_PROJECT_ID=<project id> \
VITE_EXCALIBASE_ORG_SLUG=<org slug> VITE_EXCALIBASE_PUBLISHABLE_KEY=<publishable key> npm run dev
# http://localhost:5176 ("Trending now" needs the server and a REDIS_URL: npm run build && npm start)
```

## How the code is laid out

| Path | What |
|---|---|
| `src/lib/client.ts` | the one `@excalibase/sdk` client |
| `src/lib/platform-fetch.ts` | the SDK takes one base URL; this moves GraphQL, REST and functions calls to the project's paths on the data plane (`/{projectId}/graphql`), while auth stays at `/auth/{org}/{project}` |
| `src/lib/store.ts` | every query and mutation the store makes |
| `src/lib/realtime.ts` | the order subscription (`graphql-ws`; the token goes in `connection_init`) |
| `server/` | the container's server: the SPA, `/config.js` (the project, from the app's variables), `/api/views` and `/api/trending` (Redis) |
| `setup/` | the setup script, the schema and the permissions |
| `Dockerfile` | the image the template runs: Node 22 on Alpine, pinned by digest, non-root, port 8080 |

`npm test` runs the unit tests (server, setup helpers, SPA helpers).

## Not shown here

- Product pictures are part of the app, not uploads: uploading through
  `db.storage.uploadFile` needs the project's functions runtime to reach
  Storage, which it does not on the platform yet.
