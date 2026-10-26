---
"@excalibase/sdk": minor
---

`db.auth.signInWithOtp({ email, type, emailRedirectTo, shouldCreateUser })` emails a sign-in link or six-digit code, and `verifyOtp({ type: "email", email, token })` / `verifyOtp({ type: "magiclink", token_hash })` signs in with it through PKCE; `hydrate()` finishes a link that lands back on the page.
