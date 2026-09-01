# `@excalibase/sdk` — Jira-style Board Demo

Polished kanban board styled after Jira / Linear, demonstrating
`@excalibase/sdk` against the kanban schema with full Postgres role
switching + RLS. Drag-and-drop cards across columns triggers REST
mutations whose row-level visibility depends on the active identity.

| Identity | Sees | Can do |
|---|---|---|
| Guest (anon) | `is_public = true` projects + their issues + comments | read only — comment form is replaced by an explicit "no INSERT grant" hint |
| Alice / Carol | all Acme org projects (public + private) | comment, edit own reported issues, drag own issues |
| Inventory admin | same projects | bypass owner RLS — drag/edit any in-org issue |

The footer pill shows the **resolved Postgres role** from a live
`SELECT current_user FROM kanban.whoami_view` round-trip — proving
`SET LOCAL ROLE` is firing on every request, not just being claimed.

## What's in here

| File | Role |
|---|---|
| `src/App.tsx` | Top-level layout + identity-change handler |
| `src/lib/client.ts` | SDK wiring + four pre-baked demo identities |
| `src/lib/queries.ts` | GraphQL documents |
| `src/components/Topbar.tsx` | Brand + search + identity dropdown |
| `src/components/Sidebar.tsx` | Org switcher + project list |
| `src/components/Board.tsx` | Drag-drop board (`@dnd-kit/core`) |
| `src/components/Column.tsx` / `IssueCard.tsx` | Per-column droppable + draggable cards |
| `src/components/IssueDrawer.tsx` | Slide-in detail panel + comment form (`@radix-ui/react-dialog`) |
| `src/components/Footer.tsx` | Live `whoami_view` role pill |
| `scripts/sign-tokens.mjs` | Signs the four demo JWTs against the test EC private key |

## Setup (sibling-repo layout)

This demo expects `excalibase-graphql` checked out next to
`excalibase-sdk-js` (or set `EXCALIBASE_DEMO_KEY` to point at the
test EC key elsewhere).

```bash
# In excalibase-graphql:
make demo-jira
# starts the docker stack, signs JWTs, and starts the Vite dev server
# at http://localhost:5175.
```

Or step by step:

```bash
cd ~/Documents/duk/excalibase-graphql
make demo-up

cd ~/Documents/duk/excalibase-sdk-js/examples/jira-board
npm install
npm run sign-tokens
npm run dev
# → http://localhost:5175
```

## What to look at

1. **Click "Browse as guest"** in the top-right — left rail collapses to
   2 public projects (Platform API, MVP Launch). Mobile App (private)
   is hidden by RLS, not by a client-side filter.
2. **Click an issue** — drawer slides in with comments. Anon sees the
   thread but the comment box is replaced by an inline "no INSERT grant"
   hint pointing at `kanban.comments`.
3. **Switch to Alice (Acme)** — Mobile App appears. Comment form unlocks.
   Try dragging "Setup JWT auth" from Backlog to In Progress.
4. **Switch to Inventory admin** — same projects, but the admin's
   `app_admin` policy grants `FOR ALL` on `kanban.issues` so they can
   drag issues that aren't theirs.
5. **Watch the footer** — pill flips between `app_anon` (gray),
   `app_authenticated` (blue), `app_admin` (red).

## Troubleshooting

**`Could not read demo signing key`** — set `EXCALIBASE_DEMO_KEY` or
check out `excalibase-graphql` next to `excalibase-sdk-js`.

**"Loading…" never resolves** — `curl http://localhost:10004/actuator/health`
should return JSON. If not, run `make demo-up` again.

**`401 Unauthorized` everywhere** — your demo JWTs expired (24h TTL).
Re-run `npm run sign-tokens`.

**`403 Forbidden` from a specific identity** — the role claim is rejected
by `PostgresRoleResolver`. Check the `APP_SECURITY_POSTGRES_ROLE_SWITCHING_*`
env vars in `e2e/study-cases/docker-compose.study-cases.yml`.

## Companion

`examples/storefront` is the same SDK + role-switching pattern, but on
a different schema (shopify) shaped like a real e-commerce app — anon
browse, customer cart + checkout, admin inventory editor.
