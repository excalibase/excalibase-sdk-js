---
"@excalibase/sdk": minor
---

In a browser, a request refused by CORS throws `CorsError` (a `NetworkError` with `code: "cors_blocked"`) that names the page's origin and says to add it in Studio → Settings → Allowed origins. An offline browser, a same-origin call or a server runtime keeps the plain `NetworkError`.
