---
"@excalibase/sdk": minor
---

`db.auth.getUser()` reads the signed-in account with its `userMetadata` and `appMetadata`; `updateUser({ fullName, data, email, password, currentPassword })` changes it (a password change installs the fresh session it returns; an address change mails a link that `hydrate()` or `confirmEmailChange({ tokenHash })` confirms); `signOut({ scope: "global" | "others" })` ends every or every other session. Server refusals carry their code (`reauthentication_required`, `metadata_too_large`, `email_exists`, ...).
