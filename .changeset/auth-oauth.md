---
"@excalibase/sdk": minor
---

`db.auth.signInWithOAuth({ provider, redirectTo })` and `exchangeCodeForSession(code)` sign end users in with Google or GitHub through PKCE; `hydrate()` finishes a sign-in that lands back on the page (`detectSessionInUrl`, default true).
