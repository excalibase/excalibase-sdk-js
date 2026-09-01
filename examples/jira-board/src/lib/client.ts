/**
 * SDK + identity wiring for the jira-board demo.
 *
 * Same identity model as `examples/kanban-roles` — four pre-baked JWTs
 * (anon / alice / carol / admin) that the user flips between to see how
 * RLS + Postgres role switching changes what the UI can see and do.
 *
 * Tokens are signed by `scripts/sign-tokens.mjs` against the test EC
 * private key the study-cases stack advertises via JWKS — see README for
 * setup steps.
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
  // Optional avatar tint (Tailwind class) for the topbar pill.
  tint: string;
};

// Default to same-origin so vite's dev proxy can route /graphql + /api/v1
// to :10004 without a CORS preflight. Override with VITE_API_URL when
// building for prod (e.g. behind a real reverse proxy).
const API_URL =
  import.meta.env.VITE_API_URL ??
  (typeof window !== "undefined" ? window.location.origin : "http://localhost:10004");
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID ?? "study-cases/kanban";
const PUBLISHABLE_KEY = import.meta.env.VITE_PUBLISHABLE_KEY ?? "esk_pub_demo_key";

export const IDENTITIES: DemoIdentity[] = [
  {
    key: "anon",
    label: "Guest",
    initials: "?",
    blurb: "Read-only browsing — sees only public projects.",
    accessToken: demoTokens.anon,
    scope: "public",
    pgRole: "app_anon",
    tint: "bg-slate-500",
  },
  {
    key: "alice",
    label: "Alice Chen",
    initials: "AC",
    blurb: "Acme member — can comment, edit own issues.",
    accessToken: demoTokens.alice,
    scope: "authenticated",
    pgRole: "app_authenticated",
    tint: "bg-pink-500",
  },
  {
    key: "carol",
    label: "Carol Park",
    initials: "CP",
    blurb: "Acme member — can comment, edit own issues.",
    accessToken: demoTokens.carol,
    scope: "authenticated",
    pgRole: "app_authenticated",
    tint: "bg-amber-500",
  },
  {
    key: "admin",
    label: "Admin",
    initials: "AD",
    blurb: "Full RW within Acme — bypasses owner RLS.",
    accessToken: demoTokens.admin,
    scope: "authenticated",
    pgRole: "app_admin",
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
  // Inject Authorization directly via headers — auth.hydrate() is async, so
  // the first request can fire before the session populates from storage,
  // resulting in a missing Authorization header. Direct header injection
  // bypasses that race entirely (correct for a demo with pre-baked JWTs).
  const db = createClient({
    url: API_URL,
    projectId: PROJECT_ID,
    publishableKey: PUBLISHABLE_KEY,
    autoRefreshToken: false,
    headers: {
      "Accept-Profile": "kanban",
      "Content-Profile": "kanban",
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

export function getCurrentIdentity(): DemoIdentity {
  return currentIdentity;
}

/** Map JWT key → seeded kanban.users.id, used for "yours" tagging + RLS check. */
export function userIdOf(identity: DemoIdentity): number {
  return USER_IDS[identity.key];
}
