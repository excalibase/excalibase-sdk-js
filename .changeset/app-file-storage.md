---
"@excalibase/sdk": minor
---

`db.storage` uploads, lists, downloads and deletes files through the platform's app storage API under the bucket's access rules, with no function to deploy: `uploadFile(blob, { bucket, path })`, `list`, `getDownloadUrl`, `download`, `remove`; refusals throw `StorageError`. The earlier function-based upload is `uploadViaFunctions(blob)`.
