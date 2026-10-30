# @excalibase/sdk

Official TypeScript client for [Excalibase](https://github.com/excalibase/excalibase-graphql) —
auto-generated GraphQL + REST APIs over PostgreSQL and MySQL.

- Works in both browser and Node.js (≥18)
- Persistent session with automatic refresh before JWT expiry
- Password login, publishable/secret API keys, OAuth2-style `/token` flow
- First-class typings for the full-text search (`search` / `webSearch`) and
  pgvector k-NN (`vector`) operators exposed by excalibase-graphql

## Install

```bash
npm install @excalibase/sdk graphql-request
```

## API shape

Two raw surfaces, no query-builder, no RPC wrapper — you write GraphQL or REST
directly and the SDK handles auth, session, and error wrapping:

```ts
// GraphQL
await db.graphql.query<T>("{ kanbanIssues(limit: 5) { id title } }");
await db.graphql.mutation<T>(`
  mutation ($input: CreateKanbanIssueInput!) {
    createKanbanIssue(input: $input) { id }
  }
`, { input: { title: "x" } });

// REST (PostgREST-compatible)
await db.rest.get<T>("/issues?select=id,title&limit=5");
await db.rest.post<T>("/issues", { title: "x" });
await db.rest.patch<T>("/issues?id=eq.1", { title: "y" });
await db.rest.put<T>("/issues?id=eq.1", full);
await db.rest.delete("/issues?id=eq.1");
```

Both namespaces automatically fold in the current session's bearer token +
publishable key headers, wrap 401/403 in `AuthError`, and wrap other failures
in `NetworkError`. Pick `db.graphql` for shape control / nested projections /
TS codegen; pick `db.rest` for HTTP-cacheable URLs / `Prefer: count=exact`
pagination / piping through CDNs.

In a browser, a call refused by CORS throws `CorsError` (a `NetworkError`,
`code: "cors_blocked"`) whose `origin` is the page's own origin: add it in
Studio → Settings → Allowed origins (for local development,
`http://localhost:<port>`).

## Quick start

```ts
import { createClient } from "@excalibase/sdk";

const db = createClient({
  url: "https://api.example.com",   // the platform's base URL
  projectId: "proj-a1b2c3d4e5",     // the project's id
  key: "esk_pub_live_...",          // publishable key: safe to ship in browser bundles
});

// 1. Password login (email/password user)
await db.auth.signInWithPassword({
  email: "alice@example.com",
  password: "s3cret",
});

// 2. Anonymous API-key login (no user, role "anon")
await db.auth.signInWithApiKey();

// 3. Run a GraphQL query with the current session
const data = await db.graphql.query<{ hanaCustomer: Array<{ first_name: string }> }>(`
  { hanaCustomer(limit: 5) { first_name last_name email } }
`);

// 4. React to auth state changes
const { unsubscribe } = db.auth.onAuthStateChange((event, session) => {
  console.log(event, session?.user?.email ?? "anon");
});
```

## One client per project

`url` is the platform's base URL, with no project and no service path. The
client builds every path from it and the project id, the way the platform's
edge routes them:

| Surface | Path |
|---|---|
| GraphQL (`db.graphql`, `db.from`) | `{url}/{projectId}/graphql` |
| Realtime (`db.graphql.subscribe`) | `ws(s)://{host}/{projectId}/graphql` |
| REST (`db.rest`) | `{url}/{projectId}/api/v1/...` |
| End-user auth (`db.auth`) | `{url}/auth/{orgSlug}/{projectId}/...` |
| Functions (`db.functions`, `db.storage.uploadViaFunctions`) | `{url}/functions/v1/{projectId}/{id}` |
| Files (`db.storage`) | `{url}/storage/v1/{projectId}/buckets/{bucket}/...` |

`orgSlug` is optional: auth finds the project by its id, so the org segment
defaults to the project id. `db.graphqlEndpoint()`, `db.restEndpoint(path)`,
`db.authEndpoint(path)`, `db.functionsEndpoint(name)` and
`db.realtimeEndpoint()` return the URLs the client uses.

A function is reached by its id. `db.functions.invite(args)` calls the
function whose id is `invite`; `db.functions.images.urls(args)` calls the one
whose id is `images.urls`. Both send `{"args": ...}` as the JSON body and
resolve to `data` when the function answers `{"data": ...}`. The function
itself is `export default (req: Request) => Response`:

```ts
// index.ts of the function `invite`
export default async (req: Request): Promise<Response> => {
  const { args } = await req.json();
  return Response.json({ data: { invited: args.email } });
};
```

Older options still work: `publishableKey` is read as `key`, and a
`projectId` of the form `"{orgSlug}/{projectId}"` is read as the org and the
project. A `url` that already ends in a service path (`/graphql`, `/api/v1`)
or in the project id is refused with a `ConfigError` that says what to pass
instead.

## Realtime

`db.graphql.subscribe` opens the project's WebSocket (graphql-transport-ws)
and sends the session's token in `connection_init`; each change reaches only
callers whose permissions cover the row. Turn realtime on for the table in
the project first.

```ts
const sub = db.graphql.subscribe<{ publicOrdersChanges: { operation: string; data: unknown } }>(
  "subscription { publicOrdersChanges { operation table data } }",
  {
    next: (data) => console.log(data.publicOrdersChanges),
    error: (err) => console.warn("updates stopped", err),
  },
);
// later
sub.unsubscribe();
```

Browsers and Node 22+ have a global `WebSocket`. On older Node pass one:
`createClient({ ..., WebSocket })` with `import WebSocket from "ws"`.

## File storage

Signed-in users upload, list, download and delete files straight from the
browser; no function to deploy. The bytes go to the object store on a
short-lived signed URL, so they never pass through the platform.

In Studio, create the bucket and give it **App access** rules: per role,
whether the user may read, write and delete `own` files (under a folder named
after their user id) or `all` files. A role with no rule, and a bucket with
none, refuses everything. Add your app's origin to the project's CORS list.

```ts
await db.auth.signInWithPassword({ email, password });
const me = db.auth.user()!;

// upload into the user's own folder
const file = await db.storage.uploadFile(blob, {
  bucket: "avatars",
  path: `${me.id}/avatar.png`,
});

// list the user's files (a user with an "own" rule lists their folder)
const { objects, nextCursor } = await db.storage.list("avatars");

// a URL for an <img>, or the bytes
const { url } = await db.storage.getDownloadUrl("avatars", `${me.id}/avatar.png`);
const bytes = await db.storage.download("avatars", `${me.id}/avatar.png`);

await db.storage.remove("avatars", `${me.id}/avatar.png`);
```

A refusal throws `StorageError` with the HTTP status (403 when the bucket's
rules do not allow it). Private URLs expire; a public bucket's do not.

`db.storage.uploadViaFunctions(blob)` keeps the older flow, which calls your
own `system.generateUploadUrl` and `system.completeUpload` functions.

## Security

Secret keys (`esk_sec_live_*`) are **rejected** if the SDK is initialized in
a browser context. Secret keys must only be used server-side.

```ts
// This throws ConfigError in a browser:
createClient({ ..., key: "esk_sec_live_..." });
```

## Roles

Every request runs as one role, and the project's permissions for that role
decide which tables, columns, rows and functions exist for it:

- no session, or a publishable-key session (`signInWithApiKey()`): `anon`
- a signed-in account: its role (`user` unless the project gave the account
  another one)
- a secret-key session (server-side only): `service`, which bypasses
  permissions

A token that allows more than one role can pick one per client with the
`X-Excalibase-Role` header; a role the token does not allow is refused with
403 `role_not_allowed`.

```ts
const editor = createClient({ ..., headers: { "X-Excalibase-Role": "editor" } });
```

## Full-text and vector search

Excalibase exposes both as native GraphQL arguments on tables with `tsvector`
or `pgvector` columns. The SDK has no special wrappers — just use the native
GraphQL surface:

```ts
// Plain search (safe for any user input)
await db.graphql.query(`
  { kanbanIssues(where: { search_vec: { search: "stripe payment" } }) {
      id title
  } }
`);

// Google-style search (quoted phrases, OR, -exclusion)
await db.graphql.query(`
  { kanbanIssues(where: { search_vec: { webSearch: "stripe OR benchmarks -refund" } }) {
      id title
  } }
`);

// Vector k-NN (pgvector)
await db.graphql.query(`
  { kanbanIssues(vector: {
      column: "embedding"
      near: [0.12, -0.34, 0.87]
      distance: "COSINE"
      limit: 5
  }) { id title } }
`);
```

See the [excalibase-graphql search & vector guide](https://github.com/excalibase/excalibase-graphql/blob/main/docs/features/search-and-vector.md) for the full operator reference.

## Email verification and password reset

Links in auth's emails point at the project's site URL with a `?token=`; your pages pass it back:

```ts
// /verify?token=...
const { passwordResetRequired } = await db.auth.verifyEmail({ token });

await db.auth.resendVerification({ email });
await db.auth.resetPasswordForEmail(email);           // mails /reset-password?token=...
await db.auth.updatePasswordWithToken({ token, password: newPassword });
```

`resendVerification` and `resetPasswordForEmail` resolve the same way whether or not the account exists.
Verifying an address and resetting a password both end every session the account had.

## Sign in with Google or GitHub

The project's Admin turns a provider on in Studio with the project's own OAuth app, and lists the app's redirect URLs.

```ts
// Sends the browser to the provider; it comes back to redirectTo?code=...
await db.auth.signInWithOAuth({ provider: "github", redirectTo: "https://app.example.com/auth/callback" });

// On the page it comes back to: finishes the sign-in and drops ?code= from the address bar.
const session = await db.auth.hydrate();
```

The code is redeemed with a PKCE verifier this browser kept, so a code copied elsewhere is useless.
`exchangeCodeForSession(code)` does the same step by hand. A failed sign-in comes back as `?error=<code>`,
which `hydrate()` raises as an `AuthError` with that code (`signup_disabled`, `email_not_verified`, `access_denied`, ...).

## Sign in with an emailed link or code

The project's Admin turns on "Email links and codes" in Studio. A link lands on the site URL or one of the project's redirect URLs.

```ts
// A link: the browser comes back to emailRedirectTo?token_hash=...&type=magiclink
await db.auth.signInWithOtp({ email, emailRedirectTo: "https://app.example.com/auth/callback" });
const session = await db.auth.hydrate(); // on that page: spends the link and drops it from the address bar

// A eight-digit code the user types in
await db.auth.signInWithOtp({ email, type: "email", shouldCreateUser: false });
const session = await db.auth.verifyOtp({ type: "email", email, token: "04291735" });
```

`signInWithOtp` resolves the same way whether or not the account exists. The link or code works once, for 10 minutes,
and only in the browser that asked for it (PKCE). A code allows five tries; a link one. Errors carry the server's code:
`method_not_enabled`, `rate_limited`, `invalid_or_expired_token`, `signup_disabled`, `account_disabled`.

## Guest accounts

When the project turns guests on, an app can start a session without asking for anything. The account has no
address or password and runs as the role `guest`, which reaches nothing until the project gives it permissions.

```ts
const session = await db.auth.signInAsGuest(); // or { captchaToken } when the project requires Turnstile
db.auth.user()?.isGuest; // true

// Later the same account, same id, takes an address or a provider
await db.auth.updateUser({ email: "me@example.com" }, { emailRedirectTo: "https://app.example.com/settings" });
await db.auth.linkIdentity({ provider: "github", redirectTo: "https://app.example.com/settings" });
```

A guest has nothing to sign in again with, so the SDK refreshes its session before these calls; a token issued in
the last few minutes counts as a recent sign-in. A guest sets a password only after it has an address
(`email_required` before). Once the address is confirmed or the provider linked, the account is
no longer a guest and its role `guest` becomes `user` (a role the project gave it stays). Guests unused for 30 days
are deleted. Errors carry the server's code: `method_not_enabled`, `signup_disabled`, `rate_limited`,
`captcha_required`, `captcha_failed`, `captcha_unavailable`.

## Multi-factor authentication (TOTP)

When the project turns MFA on, a signed-in user adds an authenticator app; later sign-ins start at `aal1` and step
up to `aal2` with a code from the app or a one-time recovery code. A permission can require
`x-excalibase-aal = aal2`.

```ts
// Enroll: show totp.uri as a QR code (or totp.secret to type in), then confirm with a code from the app
const factor = await db.auth.mfa.enroll({ factorType: "totp", friendlyName: "Phone" });
const { recoveryCodes } = await db.auth.mfa.challengeAndVerify({ factorId: factor.id, code: "123456" });
// recoveryCodes: 10 single-use codes, returned once with the account's first verified factor

// After each sign-in
const { currentLevel, nextLevel } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
if (currentLevel === "aal1" && nextLevel === "aal2") {
  const { totp } = await db.auth.mfa.listFactors();
  await db.auth.mfa.challengeAndVerify({ factorId: totp[0].id, code }); // or useRecoveryCode({ code })
}

await db.auth.mfa.regenerateRecoveryCodes(); // { recoveryCodes }, replaces the old set
await db.auth.mfa.unenroll({ factorId: factor.id });
```

`verify`, `challengeAndVerify` and `useRecoveryCode` rotate this session into an `aal2` one, store it and fire
`SIGNED_IN`, as a sign-in does. `getAuthenticatorAssuranceLevel` reads `aal` and `amr` from the access token without
a request (null when signed out or MFA is off) and asks for the factor list to work out `nextLevel`. Once a factor
is verified, enrolling or removing a factor, new recovery codes, and changing the address, password or linked
identities need `aal2`. Guests cannot enroll (`email_required`). A challenge lasts 5 minutes; after five wrong codes for a factor in 5
minutes it answers `too_many_attempts` for a while. Errors carry the server's code: `method_not_enabled`, `insufficient_aal`,
`invalid_code`, `invalid_challenge`, `too_many_attempts`.

## Link identities to the signed-in account

A signed-in user adds Google, GitHub or another address to the one account, then signs in with any of them.
Linking and unlinking need a sign-in in the last 5 minutes; an older session gets `reauthentication_required`,
so sign the user in again first.

```ts
// Google or GitHub: the browser goes through the provider and comes back to redirectTo?code=...
await db.auth.linkIdentity({ provider: "google", redirectTo: "https://app.example.com/settings" });
const session = await db.auth.hydrate(); // on that page: writes the link and starts a fresh session

// Another address, proven by an emailed code (or a link, which hydrate() spends)
await db.auth.linkEmail({ email: "me@work.example", type: "email" });
await db.auth.verifyOtp({ type: "email", email: "me@work.example", token: "04291735" });

const { identities, hasPassword } = await db.auth.getUserIdentities();
await db.auth.unlinkIdentity(identities[0]);
```

The link is written only when this browser's PKCE verifier redeems the code, so a code or link that leaks links
nothing. The session a link returns does not count as a fresh sign-in, so linking again needs another sign-in.
Linked addresses must be plain ASCII, and the mail says it adds the address to an account. Errors carry the server's code: `identity_already_exists` (on another account, or an address another verified
account uses), `last_sign_in_method` (no other identity and no password would be left), `email_not_verified` (the
account's own address was never proven), `reauthentication_required`, `method_not_enabled`.

## The signed-in account

```ts
const user = await db.auth.getUser(); // { id, email, fullName, emailVerified, hasPassword, userMetadata, appMetadata, createdAt }

// data merges into userMetadata: each top-level key replaces the stored one, null removes a key
await db.auth.updateUser({ fullName: "Ada", data: { theme: "dark", banner: null } });

// A new address gets a confirmation link; the old one gets a notice. Nothing changes until the link is opened.
const { emailChangeRequested } = await db.auth.updateUser(
  { email: "ada@new.example" },
  { emailRedirectTo: "https://app.example.com/settings" },
);
await db.auth.hydrate(); // on the page the link lands on (?token_hash=...&type=email_change), signed in: confirms it
await db.auth.confirmEmailChange({ tokenHash }); // or confirm it yourself; verifyOtp({ type: "email_change", token_hash }) does the same

db.auth.onAuthStateChange((event, session, error) => {
  if (event === "EMAIL_CHANGE_FAILED") showError(error); // a landed link was refused; hydrate() does not throw
});

// Ends every session of the account; the fresh one returned becomes the current session
await db.auth.updateUser({ password: "new-secret", currentPassword: "old-secret" });
```

`userMetadata` is the user's own, at most 16 KB as JSON and 8 levels deep; never trust it for permissions.
`appMetadata` is read-only here: only a secret key or Studio writes it, and `updateUser` refuses it. Neither goes
into the access token. A password change needs `currentPassword` or a sign-in in the last 5 minutes; an address
change needs a recent sign-in and a proven current address; change the two in separate calls
(`password_and_email_separately`). Confirming needs the session of the account that asked for the change, which is
then refreshed so the new address shows. When the link lands in a browser that is not signed in, `hydrate()` leaves
`?token_hash=` on the page: sign the user in, then call `confirmEmailChange` with it. Errors carry the
server's code: `reauthentication_required`, `email_not_verified`, `invalid_metadata`, `metadata_too_large`,
`rate_limited` (address changes: 1 a minute, 5 a day), `invalid_or_expired_token`, `email_exists` (another account
took the address meanwhile), `method_not_enabled`.

### Sign out

```ts
await db.auth.signOut(); // or { scope: "local" }: this session only
await db.auth.signOut({ scope: "global" }); // every session of the user, on every device
await db.auth.signOut({ scope: "others" }); // every session but this one
```

`local` ignores a server failure and always clears this session. `global` also always clears this session; when the
server refuses it, it still revokes this session's refresh token the `local` way, then throws the server's error
(`method_not_enabled`, `invalid_scope`). `others` never clears this
session and throws a server error as is.

## API key management

Authenticated users can mint and revoke API keys for the current project:

```ts
// Requires an authenticated session (password login)
await db.auth.signInWithPassword({ email, password });

const created = await db.auth.createApiKey({
  name: "web-frontend",
  keyType: "publishable",   // or "secret"
});
console.log("Save this once, never again:", created.plaintext);

const keys = await db.auth.listApiKeys();
await db.auth.revokeApiKey(created.id);
```

## Session persistence

By default the SDK stores the session in `localStorage` when a browser is
detected, and in memory otherwise. Pass a custom `StorageAdapter` to integrate
with secure storage:

```ts
import { createClient, memoryStorageAdapter } from "@excalibase/sdk";

const db = createClient({
  url: "https://api.example.com",
  projectId: "proj-a1b2c3d4e5",
  key: "esk_pub_live_...",
  storage: memoryStorageAdapter(),  // or your own { getItem, setItem, removeItem }
});
```

## License

Apache-2.0
