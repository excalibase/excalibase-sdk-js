# Storefront: a small store built on Excalibase

A working shop, "Larch & Co.", that uses an Excalibase project end to end and
runs on the platform's Containers. It is the store shown in the Excalibase demo
videos.

| Who | Sees and does |
|---|---|
| Guest (`anon`, no token) | browses the catalog and the best sellers; no cart, no orders: those tables do not exist for `anon` |
| Customer (`user`, a signed-in account) | a cart and orders that are only their own; places an order with its line items in one mutation; sees its status change live |
| Staff (the custom role `staff`) | every order, with the customer's email; changes order status; edits prices, stock and what is on sale; adds products; uploads product pictures |

What it uses:

- **API permissions** (one rule per table, role and operation, the Hasura
  model): the same GraphQL documents run for every role and return what that
  role may see. Presets fill `customer_id` and `customer_email` from the token,
  so a customer cannot write rows for someone else.
- **A custom role** given to an account through the project's end-user role
  API (`staff`, allowed to act as `user` too).
- **A nested insert**: an order and its line items in one `createPublicOrders`
  mutation. The line items' insert permission admits a line only on the
  customer's own open order (the check sees the order inserted just before it);
  database triggers price each line, take stock (an order that would oversell
  fails as a whole) and total the order.
- **A tracked function**: `best_sellers(top)` ranks products by units sold. It
  is `STABLE`, so it is a query every role that reads products may call, and
  its rows pass through the caller's own products permission (guests never see
  a product that is not on sale, even if it sells).
- **Realtime**: `publicOrdersChanges` over the project's GraphQL websocket. A
  customer's order list updates when staff ship the order; staff see new orders
  arrive. Each change reaches only callers whose permission covers the row.
- **End-user auth** through `@excalibase/sdk` (sign up, sign in, session kept
  and refreshed).
- **Storage**: product pictures are uploaded by staff with
  `db.storage.uploadFile(file)` and live in the project's Storage, not in the
  store's image. The store deploys three functions (`functions/`): the two
  mutations `uploadFile` calls by default, `system.generateUploadUrl` and
  `system.completeUpload`, which refuse anyone whose verified token is not
  `staff` (`403`; no token is `401`) and anything but a png, jpeg, webp or gif
  up to 5 MB (`400`), by throwing `FunctionError`; and the query
  `images.urls`, which turns storage ids into short-lived links for every
  caller. A product names its picture by storage id (`image_id`, which only
  staff may set), so a picture is seen by whoever may read its product, and
  an id from another project resolves to nothing.
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
2. Make a personal access token for the setup script. In Studio, open
   **Access tokens** (in the sidebar, or click your name), name it
   `storefront setup`, choose **Read and write**, pick this project and a short
   expiry such as 7 days, then **Create token** and copy it: it is shown once.
   You must be an Admin or Owner of the project's organization, because the
   script sets the demo accounts' roles. Revoke the token in the same place when
   the store is set up.
3. Run the setup script against the project with that token:

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
   `orders`, the store's functions (`/api/projects/{id}/functions`), a
   publishable key, CORS for the store's URL, three demo accounts
   (`alice@` and `bob@` customers, `sam@` staff, under `example.test` unless
   `DEMO_EMAIL_DOMAIN` says otherwise; one password, from `DEMO_PASSWORD` or
   generated and printed), the sample pictures (`setup/images`) uploaded to
   Storage as `sam@` through the store's upload functions, and the store's
   `EXCALIBASE_*` variables (including `EXCALIBASE_STORAGE_ORIGIN`, where
   pictures are served from, for its Content-Security-Policy), after which the
   store is redeployed. Running it again is safe with the same `DEMO_PASSWORD`:
   what exists is kept. `EXCALIBASE_DATA_API_URL` names where the script
   itself reaches the project's GraphQL and functions when that differs from
   the data URL the browser uses.
   The script also ships in the store's image, so no checkout is needed:
   `docker run --rm -e EXCALIBASE_API=… -e EXCALIBASE_TOKEN=… -e EXCALIBASE_DATA_URL=… -e PROJECT_ID=… <the template's image> node setup/setup.mjs`.
4. Open the store's URL (printed at the end, and shown on the app in Studio).

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
| `src/lib/client.ts` | the one `@excalibase/sdk` client: `createClient({ url, projectId, orgSlug, key })`, which builds the project's paths itself |
| `src/lib/store.ts` | every query and mutation the store makes |
| `src/lib/realtime.ts` | the order subscription (`db.graphql.subscribe`; the SDK sends the token in `connection_init`) |
| `src/lib/images.ts` | picture links: every picture a render needs is asked for in one `images.urls` call, renewed before the links expire |
| `functions/` | the store's functions and its storage rules (`storage-rules.ts`) |
| `server/` | the container's server: the SPA, `/config.js` (the project, from the app's variables), `/api/views` and `/api/trending` (Redis) |
| `setup/` | the setup script, the schema and the permissions |
| `Dockerfile` | the image the template runs: Node 22 on Alpine, pinned by digest, non-root, port 8080 |

`npm test` runs the unit tests (server, setup helpers, SPA helpers).

## Storage on your own install

The browser uploads straight to the object store with the signed URL the
platform mints, so the bucket must allow `PUT` from the store's origin (CORS
on the R2 bucket; MinIO allows it by default).
