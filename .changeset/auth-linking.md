---
"@excalibase/sdk": minor
---

`db.auth.linkIdentity({ provider, redirectTo })` and `linkEmail({ email, type })` add Google, GitHub or another address to the signed-in account through PKCE; `getUserIdentities()` lists them and `unlinkIdentity(identity)` removes one unless it is the last way in. Server refusals carry their code (`reauthentication_required`, `identity_already_exists`, `last_sign_in_method`, ...).
