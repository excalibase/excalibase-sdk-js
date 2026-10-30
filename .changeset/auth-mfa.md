---
"@excalibase/sdk": minor
---

`db.auth.mfa` adds TOTP multi-factor sign-in: `enroll`, `challenge`, `verify`, `challengeAndVerify`, `unenroll`, `listFactors`, `getAuthenticatorAssuranceLevel`, `useRecoveryCode` and `regenerateRecoveryCodes`. A verified code or a recovery code rotates the session to `aal2`, stores it and fires the new `MFA_CHALLENGE_VERIFIED` event; the first verified factor returns ten one-time recovery codes. Refusals carry their code (`method_not_enabled`, `insufficient_aal`, `invalid_code`, `invalid_challenge`, `too_many_attempts`, `session_changed`, `invalid_response`).
