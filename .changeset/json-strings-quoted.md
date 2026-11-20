---
"@excalibase/sdk": patch
---

A string inside a JSON value is always sent as a quoted, escaped GraphQL string. `{ kind: "doc" }` used to go out as `{ kind: doc }`, which GraphQL reads as an enum literal, so the engine could store or compare a different value than the one sent. This applies to objects and arrays at any depth, and to `jsonContains` and `containedBy` lists. Plain filter values and `in` lists on a client with no schema still send lowercase names bare, as before. A value that reuses the same object many times is now checked and serialized once per object instead of once per use, which was exponential for values built in code. Circular and over-deep values are still refused.
