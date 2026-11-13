---
"@excalibase/sdk": patch
---

Security fix: the query builder no longer lets caller data inject extra GraphQL. Column, operator, field, enum and `orderBy` names are checked against `^[_A-Za-z][_0-9A-Za-z]*$` and the builder throws a `ConfigError` on anything else; `null`, `true` and `false` are rejected as enum values; `orderBy` directions must be `asc` or `desc`; numbers, `limit`, `offset` and vector inputs must be numeric; the strings `true`, `false` and `null` are quoted instead of becoming keywords.

REST changes, some of which can change which rows a call touches:
- `contains` now sends `ilike.%value%`, so it matches substrings. Before, it matched the whole value. A REST `update` or `delete` that uses `contains` may now touch more rows than before. Check those calls.
- `startsWith` and `endsWith` now use the engine's `startswith` and `endswith` operators. Before, they sent `like.value` with no wildcard, which matched only the exact value, so they now match more rows too.
- `in`, `notIn` and `hasKeys` values containing a comma now throw a `ConfigError`, because the engine would split them into extra values. `arrayContains`, `arrayHasAll` and `arrayHasAny` quote values that hold commas, brackets, quotes or spaces.
- `.or()` and `_or` throw a `ConfigError` over REST instead of being dropped silently, which used to make REST reads, updates and deletes match more rows than asked. Use the GraphQL transport for or-groups.
- REST throws a `ConfigError` when one column has more than one filter (for example `created: { gte, lt }`, or several operators inside `not`), because the engine keeps only the first value per parameter and a range update or delete would match more rows than asked. Use the GraphQL transport for ranges. An empty `in` or `notIn` list also throws over REST, and REST reads now send `not` correctly.
- `count()` now includes `.or()` conditions over GraphQL (it used to drop them) and throws over REST like the other REST calls.
- The rule is that a condition is either sent or the call throws, so none is silently dropped any more. GraphQL `update` and `delete` now send `.or()` (they used to ignore it and could touch more rows than asked). A mutation with no filter at all, including `where({})`, throws on both transports. `not` must be an object with at least one operator; empty or non-object column filters throw; `_or` / `.or()` must be a non-empty array, and giving both `.or()` and `where({ _or })` throws. `.vector()` and `.aggregate()` throw over REST and when combined with each other; `.aggregate()` throws with `orderBy`, `limit` or `offset`; mutations throw with `orderBy`, `limit`, `offset`, `vector` or `aggregate` (and `insert` with `where`/`or`); `count()` throws with any of those.

The README now says sessions are kept in `localStorage` by default and shows `memoryStorageAdapter()` as the alternative.
