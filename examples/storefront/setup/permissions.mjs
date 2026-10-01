// Who may do what, one entry per (table, role, operation), in the shape the
// control plane's permission API takes. Anything not listed does not exist for
// that role: anon has no cart and no orders, a customer never sees another
// customer's rows, and only staff see products that are not on sale.

const ME = 'X-Excalibase-User-Id';
const own = { customer_id: { _eq: ME } };
const everything = {};

const PRODUCT_COLUMNS = ['id', 'category_id', 'name', 'description', 'price', 'stock', 'image_url', 'active'];

const catalog = (role) => [
  { table: 'public.categories', role, operation: 'select', rule: { filter: everything, columns: '*' } },
  {
    table: 'public.products', role, operation: 'select',
    rule: { filter: { active: { _eq: true } }, columns: PRODUCT_COLUMNS, limit: 100 },
  },
];

const customer = [
  ...catalog('user'),
  { table: 'public.cart_items', role: 'user', operation: 'select', rule: { filter: own, columns: '*' } },
  {
    table: 'public.cart_items', role: 'user', operation: 'insert',
    rule: { check: own, columns: ['product_id', 'quantity'], set: { customer_id: ME } },
  },
  {
    table: 'public.cart_items', role: 'user', operation: 'update',
    rule: { filter: own, check: own, columns: ['quantity'] },
  },
  { table: 'public.cart_items', role: 'user', operation: 'delete', rule: { filter: own } },
  { table: 'public.orders', role: 'user', operation: 'select', rule: { filter: own, columns: '*' } },
  {
    // A customer places an order for themselves; status, total and owner are
    // not theirs to set.
    table: 'public.orders', role: 'user', operation: 'insert',
    rule: {
      check: own,
      columns: ['note'],
      set: { customer_id: ME, customer_email: 'X-Excalibase-Email' },
    },
  },
  { table: 'public.order_items', role: 'user', operation: 'select', rule: { filter: own, columns: '*' } },
  {
    table: 'public.order_items', role: 'user', operation: 'insert',
    rule: { check: own, columns: ['order_id', 'product_id', 'quantity'], set: { customer_id: ME } },
  },
];

const staff = [
  { table: 'public.categories', role: 'staff', operation: 'select', rule: { filter: everything, columns: '*' } },
  {
    table: 'public.products', role: 'staff', operation: 'select',
    rule: { filter: everything, columns: '*', allowAggregations: true },
  },
  {
    table: 'public.products', role: 'staff', operation: 'insert',
    rule: { check: everything, columns: PRODUCT_COLUMNS.filter((column) => column !== 'id') },
  },
  {
    table: 'public.products', role: 'staff', operation: 'update',
    rule: { filter: everything, check: everything, columns: ['name', 'description', 'price', 'stock', 'active'] },
  },
  {
    table: 'public.orders', role: 'staff', operation: 'select',
    rule: { filter: everything, columns: '*', allowAggregations: true },
  },
  {
    table: 'public.orders', role: 'staff', operation: 'update',
    rule: { filter: everything, check: everything, columns: ['status'] },
  },
  { table: 'public.order_items', role: 'staff', operation: 'select', rule: { filter: everything, columns: '*' } },
];

export const PERMISSIONS = [...catalog('anon'), ...customer, ...staff];

// STABLE, so it is a query; every role that reads products may call it, and
// its rows are filtered by that role's products permission.
export const TRACKED_FUNCTIONS = [{ function: 'public.best_sellers', inferPermissions: true, sessionArgument: null }];

// Order status changes stream to the customer who owns the order and to staff.
export const REALTIME_TABLES = [{ schema: 'public', table: 'orders' }];
