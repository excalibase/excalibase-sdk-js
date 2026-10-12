---
"@excalibase/sdk": patch
---

`json-schema-to-typescript` is no longer installed with the SDK: the `excalibase-codegen` CLI bundles it, so client users get a smaller install and the CLI works as before. A script that signs in already exits on its own (the refresh timer is unref'd); `db.auth.stopAutoRefresh()` stops it explicitly.
