/**
 * SDK + identity wiring for the storefront demo.
 *
 * Same identity model as `examples/jira-board` — four pre-baked JWTs
 * (anon / alice / carol / admin) — but with projectId="shopify" so they
 * route to the ecommerce database instead of the kanban one.
 *
 * userId values are aligned with `shopify.customers.id` so the helper
 * `shopify.current_customer_id()` (set in init-shopify-rls.sql) returns
 * the matching row.
 */
import { createClient, type DbClient } from "@excalibase/sdk";
import demoTokens from "../demo-tokens.json";

export type DemoIdentity = {
  key: "anon" | "alice" | "carol" | "admin";
  label: string;
  initials: string;
  blurb: string;
  accessToken: string;
  scope: "public" | "authenticated" | "service";
  pgRole: "app_anon" | "app_authenticated" | "app_admin" | "app_service";
  tint: string;
};

// Default to same-origin so vite's dev proxy can route /graphql + /api/v1
// to :10004 without a CORS preflight. Override with VITE_API_URL for prod.
const API_URL =
  import.meta.env.VITE_API_URL ??
  (typeof window !== "undefined" ? window.location.origin : "http://localhost:10004");
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID ?? "study-cases/shopify";
const PUBLISHABLE_KEY = import.meta.env.VITE_PUBLISHABLE_KEY ?? "esk_pub_demo_key";

export const IDENTITIES: DemoIdentity[] = [
  {
    key: "anon", label: "Browse as guest", initials: "?",
    blurb: "Public visitor — read-only catalog access.",
    accessToken: demoTokens.anon, scope: "public", pgRole: "app_anon",
    tint: "bg-slate-500",
  },
  {
    key: "alice", label: "Alice Chen", initials: "AC",
    blurb: "Customer #1 — sees own orders, can checkout + write reviews.",
    accessToken: demoTokens.alice, scope: "authenticated", pgRole: "app_authenticated",
    tint: "bg-pink-500",
  },
  {
    key: "carol", label: "Carol Park", initials: "CP",
    blurb: "Customer #3 — different orders, different RLS-visible rows.",
    accessToken: demoTokens.carol, scope: "authenticated", pgRole: "app_authenticated",
    tint: "bg-amber-500",
  },
  {
    key: "admin", label: "Inventory admin", initials: "AD",
    blurb: "JWT carries role=app_admin — bypasses customer RLS, edits inventory.",
    accessToken: demoTokens.admin, scope: "authenticated", pgRole: "app_admin",
    tint: "bg-brand-500",
  },
];

const USER_IDS: Record<DemoIdentity["key"], number> = {
  anon: 0, alice: 1, carol: 3, admin: 1,
};

let currentClient: DbClient | null = null;
let currentIdentity: DemoIdentity = IDENTITIES[0];

export function setIdentity(identity: DemoIdentity): DbClient {
  currentIdentity = identity;
  // Authorization injected directly — auth.hydrate() is async and racy with
  // the first React Query refetch.
  const db = createClient({
    url: API_URL,
    projectId: PROJECT_ID,
    publishableKey: PUBLISHABLE_KEY,
    autoRefreshToken: false,
    headers: {
      "Accept-Profile": "shopify",
      "Content-Profile": "shopify",
      Authorization: `Bearer ${identity.accessToken}`,
    },
  });
  currentClient = db;
  return db;
}

export function getClient(): DbClient {
  if (!currentClient) return setIdentity(currentIdentity);
  return currentClient;
}

export function userIdOf(identity: DemoIdentity): number {
  return USER_IDS[identity.key];
}
