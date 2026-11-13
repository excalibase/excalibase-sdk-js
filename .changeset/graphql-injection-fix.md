---
"@excalibase/sdk": patch
---

Security fix: the query builder no longer lets caller data inject extra GraphQL. Column, operator, field, enum and `orderBy` names are checked against `^[_A-Za-z][_0-9A-Za-z]*$` and the builder throws a `ConfigError` on anything else; `orderBy` directions must be `asc` or `desc`; numbers, `limit`, `offset` and vector inputs must be numeric; the strings `true`, `false` and `null` are quoted instead of becoming keywords. REST `in`, `notIn` and array filter values containing commas, brackets, quotes or spaces are now double-quoted so they stay one list member, and `contains` on REST now sends `ilike.%value%` (with `%`, `_` and `\` escaped). The README now says sessions are kept in `localStorage` by default and shows `memoryStorageAdapter()` as the alternative.
