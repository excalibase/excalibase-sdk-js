---
"@excalibase/sdk": minor
---

`db.auth.signInAsGuest({ captchaToken? })` starts a session for a guest account with no address or password (role `guest`); `user().isGuest` says so. A guest keeps its id when it adds an address (`updateUser({ email })`, then the confirmation link) or a provider (`linkIdentity`); the SDK refreshes a guest's session first so those count as a recent sign-in. Refusals carry their code (`method_not_enabled`, `signup_disabled`, `rate_limited`, `captcha_required`, `captcha_failed`, `captcha_unavailable`).
