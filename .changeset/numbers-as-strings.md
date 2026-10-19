---
"@excalibase/sdk": minor
---

Numeric/decimal and bigint fields are now strings, in GraphQL and REST, on Postgres and MySQL: the API sends them as strings holding every digit (`"19.90"`, `"9223372036854775807"`), because a JavaScript number rounds past 2^53 and loses decimal digits. Generated types say `string` for `BigInteger`, `BigDecimal`, `BigInt` and `Long` columns. Filters and writes still accept a number or a string. If your code does arithmetic on these fields, convert first (`Number(row.price)` when rounding is fine, or a decimal library when it is not).
