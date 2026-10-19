---
"@excalibase/sdk": minor
---

`db.functions.<id>(args)` calls a function whose id has no dot, such as one named `invite` in Studio or with `deploy_function`; `db.functions.<a>.<b>(args)` still calls the id `a.b`.
