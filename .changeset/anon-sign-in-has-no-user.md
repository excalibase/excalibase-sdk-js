---
"@excalibase/sdk": patch
---

`db.auth.user()` is `null` after `signInWithApiKey()`: an anonymous session has no user, even when an older auth server answers a placeholder `{ id: 0 }`.
