import { createClient, str, unquoted, ConfigError } from "../src";
import type { WhereInput } from "../src/query-builder";
import { memoryStorageAdapter } from "../src/storage";

const base = {
  url: "http://localhost:10000",
  projectId: "acme/prod",
  publishableKey: "esk_pub_live_testkey1234567890",
  storage: memoryStorageAdapter(),
  autoRefreshToken: false,
  fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
};

const EVIL_KEY = "x }) { id } y: deleteUsers(where:{id:{gt:0}}) { id";
const EVIL_ENUM = "todo } }) { id } y: deleteUsers(where:{id:{gt:0}}) { id";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plain = (): any => createClient<any>(base).from("users", { table: "users" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const typed = (): any =>
  createClient<any>({
    ...base,
    schema: { users: { field: "users", enumColumns: ["status"], rest: { table: "users" } } },
  }).from("users", { table: "users" });

describe("GraphQL injection through names", () => {
  it("rejects a malicious where column key", () => {
    expect(() => plain().where({ [EVIL_KEY]: { eq: 1 } }).toGraphql()).toThrow(ConfigError);
  });
  it("rejects a malicious operator key", () => {
    expect(() => plain().where({ id: { [EVIL_KEY]: 1 } }).toGraphql()).toThrow(ConfigError);
  });
  it("rejects a malicious key inside not", () => {
    expect(() => plain().where({ id: { not: { [EVIL_KEY]: 1 } } }).toGraphql()).toThrow(ConfigError);
  });
  it("rejects a malicious key in _or conditions", () => {
    expect(() => plain().or([{ [EVIL_KEY]: { eq: 1 } }]).toGraphql()).toThrow(ConfigError);
  });
  it("rejects a malicious key nested inside a JSON filter value", () => {
    expect(() => plain().where({ meta: { jsonContains: { [EVIL_KEY]: 1 } } }).toGraphql()).toThrow(ConfigError);
  });
  it("rejects a malicious insert column key", () => {
    expect(() => plain().insert({ [EVIL_KEY]: 1 }).toGraphql()).toThrow(ConfigError);
    expect(() => typed().insert([{ [EVIL_KEY]: 1 }, { a: 1 }]).toGraphql()).toThrow(ConfigError);
  });
  it("rejects a malicious update column key", () => {
    expect(() => plain().update({ [EVIL_KEY]: 1 }).where({ id: { eq: 1 } }).toGraphql()).toThrow(ConfigError);
  });
  it("rejects a malicious orderBy key", () => {
    expect(() => plain().orderBy({ [EVIL_KEY]: "asc" }).toGraphql()).toThrow(ConfigError);
  });
  it("rejects an orderBy direction that is not asc or desc", () => {
    expect(() => plain().orderBy({ id: "ASC, x: DESC } ) { id } z: a(x:{" }).toGraphql()).toThrow(ConfigError);
  });
  it("rejects malicious select, returning and aggregate columns", () => {
    expect(() => plain().select(EVIL_KEY).toGraphql()).toThrow(ConfigError);
    expect(() => plain().insert({ a: 1 }).returning(EVIL_KEY).toGraphql()).toThrow(ConfigError);
    expect(() => plain().aggregate({ sum: [EVIL_KEY] }).toGraphql()).toThrow(ConfigError);
  });
  it("rejects a malicious field name", () => {
    const b = createClient<any>(base).from(EVIL_KEY); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(() => b.toGraphql()).toThrow(ConfigError);
  });
  it("rejects a malicious count() field name before sending", async () => {
    const b = createClient<any>(base).from(EVIL_KEY); // eslint-disable-line @typescript-eslint/no-explicit-any
    await expect(b.count()).rejects.toBeInstanceOf(ConfigError);
  });
  it("names the offending name in the error without echoing a huge payload", () => {
    expect(() => plain().orderBy({ "bad name": "asc" }).toGraphql()).toThrow(/bad name/);
  });
});

describe("GraphQL injection through values", () => {
  it("rejects a malicious enum value on an enum column (where)", () => {
    expect(() => typed().where({ status: { eq: EVIL_ENUM } }).toGraphql()).toThrow(ConfigError);
    expect(() => typed().where({ status: { in: ["todo", EVIL_ENUM] } }).toGraphql()).toThrow(ConfigError);
  });
  it("rejects a malicious enum value on an enum column (insert and update)", () => {
    expect(() => typed().insert({ status: EVIL_ENUM }).toGraphql()).toThrow(ConfigError);
    expect(() => typed().update({ status: EVIL_ENUM }).where({ id: { eq: 1 } }).toGraphql()).toThrow(ConfigError);
  });
  it("rejects a malicious unquoted() value", () => {
    expect(() => plain().where({ id: { eq: unquoted(EVIL_ENUM) } }).toGraphql()).toThrow(ConfigError);
  });
  it("rejects non-finite numbers and non-integer limit/offset", () => {
    expect(() => plain().where({ id: { eq: NaN } }).toGraphql()).toThrow(ConfigError);
    expect(() => plain().where({ id: { eq: Infinity } }).toGraphql()).toThrow(ConfigError);
    expect(() => plain().limit("1) { id } y: deleteUsers(where:{}" as unknown as number).toGraphql()).toThrow(ConfigError);
    expect(() => plain().offset(1.5).toGraphql()).toThrow(ConfigError);
  });
  it("rejects vector input that is not numeric or a known distance", () => {
    expect(() => plain().vector({ column: "e", near: ["1] }) { id } y: z(a:["] as unknown as number[] }).toGraphql()).toThrow(ConfigError);
    expect(() => plain().vector({ column: "e", near: [1], distance: "L2 } y: z" as "L2" }).toGraphql()).toThrow(ConfigError);
  });
  it("keeps a vector column with quotes inside a single string literal", () => {
    const { document } = plain().vector({ column: 'a"b', near: [1, 2] }).toGraphql();
    expect(document).toContain('column: "a\\"b"');
  });
  it("sends a quote or brace-laden string value as one escaped literal", () => {
    const { document } = typed().where({ title: { eq: 'x"}) { id } y: deleteUsers(where:{}) { id' } }).toGraphql();
    expect(document).toBe('{ users(where: { title: { eq: "x\\"}) { id } y: deleteUsers(where:{}) { id" } }) { __typename } }');
  });
  it("quotes the strings true, false and null instead of emitting keywords", () => {
    const { document } = plain().where({ a: { eq: "null" }, b: { eq: "true" } }).toGraphql();
    expect(document).toContain('a: { eq: "null" }');
    expect(document).toContain('b: { eq: "true" }');
  });
});

describe("existing GraphQL behaviour still works", () => {
  it("still emits enum-like strings bare and enum columns bare", () => {
    expect(plain().where({ s: { eq: "in_progress" } }).toGraphql().document).toContain("s: { eq: in_progress }");
    expect(typed().where({ status: { eq: "Open_2" } }).toGraphql().document).toContain("status: { eq: Open_2 }");
  });
  it("still serializes mutations, orderBy, vector, aggregate, str()", () => {
    expect(typed().insert({ status: "todo", title: "a b" }).toGraphql().document).toBe(
      'mutation { createUsers(input: { status: todo, title: "a b" }) { __typename } }',
    );
    expect(plain().orderBy({ id: "desc" }).toGraphql().document).toContain("orderBy: { id: DESC }");
    expect(plain().vector({ column: "e", near: [1, 0.5], distance: "COSINE", limit: 3 }).toGraphql().document).toContain(
      'vector: { column: "e", near: [1, 0.5], distance: COSINE, limit: 3 }',
    );
    expect(plain().where({ t: { eq: str("alpha") } }).toGraphql().document).toContain('t: { eq: "alpha" }');
  });
});

describe("REST filter values", () => {
  const rest = (where: Record<string, unknown>) => decodeURIComponent(plain().where(where).toRest().path);

  it("keeps plain in-lists unchanged", () => {
    expect(rest({ s: { in: ["todo", "done"] } })).toBe("/users?s=in.(todo,done)");
  });
  it("sends in/notIn values unquoted, as the engine splits on commas and never strips quotes", () => {
    expect(rest({ s: { in: ["New York", "(g)"] } })).toBe("/users?s=in.(New+York,(g))");
    expect(rest({ s: { notIn: ["a b"] } })).toBe("/users?s=not.in.(a+b)");
  });
  it("throws when an in/notIn value contains a comma", () => {
    expect(() => plain().where({ s: { in: ["x,admin,y"] } }).toRest()).toThrow(ConfigError);
    expect(() => plain().where({ s: { notIn: ["a,b"] } }).toRest()).toThrow(ConfigError);
  });
  it("quotes array filter values the same way", () => {
    expect(rest({ t: { arrayContains: ["bug", "a,b", "}x"] } })).toBe('/users?t=cs.{bug,"a,b","}x"}');
    expect(() => plain().where({ t: { hasKeys: ["k", "a,b"] } }).toRest()).toThrow(ConfigError);
  });
  it("maps contains to ilike with %...%", () => {
    expect(rest({ title: { contains: "foo" } })).toBe("/users?title=ilike.%foo%");
  });
  it("escapes LIKE wildcards inside contains", () => {
    expect(rest({ title: { contains: "50%_" } })).toBe("/users?title=ilike.%50\\%\\_%");
  });
  it("applies the same comma check to REST mutations' where", async () => {
    const calls: string[] = [];
    const db = createClient<any>({ // eslint-disable-line @typescript-eslint/no-explicit-any
      ...base,
      fetch: (async (u: RequestInfo | URL) => {
        calls.push(String(u));
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await expect(
      db.from("users", { table: "users" }).via("rest").delete().where({ s: { in: ["a,b"] } }).execute(),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(calls).toHaveLength(0);
  });
});

describe("keywords are not enum values", () => {
  it.each(["null", "true", "false"])("rejects %s as an enum or unquoted value", (kw) => {
    expect(() => typed().where({ status: { eq: kw } }).toGraphql()).toThrow(ConfigError);
    expect(() => typed().where({ status: { in: ["todo", kw] } }).toGraphql()).toThrow(ConfigError);
    expect(() => typed().insert({ status: kw }).toGraphql()).toThrow(ConfigError);
    expect(() => typed().update({ status: kw }).where({ id: { eq: 1 } }).toGraphql()).toThrow(ConfigError);
    expect(() => plain().where({ id: { eq: unquoted(kw) } }).toGraphql()).toThrow(ConfigError);
  });
  it("still accepts a real null value on an enum column", () => {
    expect(typed().where({ status: { eq: null } }).toGraphql().document).toContain("status: { eq: null }");
  });
});

describe("REST refuses an or-group it cannot send", () => {
  const withOr: WhereInput[] = [{ a: { eq: 1 } }, { b: { eq: 2 } }] as WhereInput[];
  it("throws from toRest for where._or and .or()", () => {
    expect(() => plain().where({ t: { eq: 5 }, _or: withOr } as WhereInput).toRest()).toThrow(ConfigError);
    expect(() => plain().where({ t: { eq: 5 } }).or(withOr).toRest()).toThrow(ConfigError);
  });
  it("throws for REST update and delete without sending a request", async () => {
    const calls: string[] = [];
    const db = createClient<any>({ // eslint-disable-line @typescript-eslint/no-explicit-any
      ...base,
      fetch: (async (u: RequestInfo | URL) => {
        calls.push(String(u));
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    const del = db.from("users", { table: "users" }).via("rest").delete().where({ t: { eq: 5 }, _or: withOr } as WhereInput);
    await expect(del.execute()).rejects.toBeInstanceOf(ConfigError);
    const upd = db.from("users", { table: "users" }).via("rest").update({ a: 1 }).where({ t: { eq: 5 } }).or(withOr);
    await expect(upd.execute()).rejects.toBeInstanceOf(ConfigError);
    expect(calls).toHaveLength(0);
  });
  it("still allows or-groups over GraphQL", () => {
    expect(plain().where({ t: { eq: 5 } }).or(withOr).toGraphql().document).toContain("_or:");
  });
});

describe("REST startsWith / endsWith", () => {
  it("use the engine's startswith / endswith operators with the raw value", () => {
    expect(decodeURIComponent(plain().where({ n: { startsWith: "ab" } }).toRest().path)).toBe("/users?n=startswith.ab");
    expect(decodeURIComponent(plain().where({ n: { endsWith: "yz" } }).toRest().path)).toBe("/users?n=endswith.yz");
  });
});

describe("count() keeps or-groups", () => {
  const orGroup = [{ id: { eq: 1 } }] as WhereInput[];
  it("throws over REST like the other REST paths", async () => {
    await expect(plain().via("rest").where({ t: { eq: 5 } }).or(orGroup).count()).rejects.toBeInstanceOf(ConfigError);
  });
  it("sends the or-group in the GraphQL aggregate", async () => {
    const docs: string[] = [];
    const db = createClient<any>({ // eslint-disable-line @typescript-eslint/no-explicit-any
      ...base,
      fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        docs.push(String(init?.body));
        return new Response(JSON.stringify({ data: { usersAggregate: { count: 1 } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    await db.from("users").where({ t: { eq: 5 } }).or(orGroup).count();
    expect(docs[0]).toContain("_or:");
    expect(docs[0]).toContain("usersAggregate(where: { t: { eq: 5 }, _or: [{ id: { eq: 1 } }] })");
  });
});

describe("REST sends at most one filter per column", () => {
  const range = { created: { gte: "2026-01-01", lt: "2026-02-01" } };
  it("throws for two operators on one column in reads", () => {
    expect(() => plain().where(range).toRest()).toThrow(ConfigError);
  });
  it("throws for update, delete and count too, without sending a request", async () => {
    const calls: string[] = [];
    const db = createClient<any>({ // eslint-disable-line @typescript-eslint/no-explicit-any
      ...base,
      fetch: (async (u: RequestInfo | URL) => {
        calls.push(String(u));
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    const q = () => db.from("users", { table: "users" }).via("rest");
    await expect(q().delete().where(range).execute()).rejects.toBeInstanceOf(ConfigError);
    await expect(q().update({ a: 1 }).where(range).execute()).rejects.toBeInstanceOf(ConfigError);
    await expect(q().where(range).count()).rejects.toBeInstanceOf(ConfigError);
    expect(calls).toHaveLength(0);
  });
  it("throws for several operators inside not", () => {
    expect(() => plain().where({ c: { not: { eq: 1, gt: 5 } } }).toRest()).toThrow(ConfigError);
  });
  it("still allows one operator per column across many columns", () => {
    expect(decodeURIComponent(plain().where({ a: { gte: 1 }, b: { lt: 2 } }).toRest().path)).toBe("/users?a=gte.1&b=lt.2");
  });
  it("is not applied to GraphQL, which sends one object per column", () => {
    expect(plain().where(range).toGraphql().document).toContain("created: { gte:");
  });
});

describe("REST reads handle not and empty lists", () => {
  it("sends not as a not. prefix on reads", () => {
    expect(decodeURIComponent(plain().where({ c: { not: { eq: 1 } } }).toRest().path)).toBe("/users?c=not.eq.1");
  });
  it("throws on empty in/notIn lists", () => {
    expect(() => plain().where({ s: { in: [] } }).toRest()).toThrow(ConfigError);
    expect(() => plain().where({ s: { notIn: [] } }).toRest()).toThrow(ConfigError);
  });
});

describe("nothing is dropped: specific cases", () => {
  const asRest = () => plain().via("rest");
  it("GraphQL update and delete send .or() and refuse an empty filter", () => {
    const orGroup = [{ id: { eq: 1 } }] as WhereInput[];
    expect(plain().delete().where({ t: { eq: 5 } }).or(orGroup).toGraphql().document).toBe(
      "mutation { deleteUsers(where: { t: { eq: 5 }, _or: [{ id: { eq: 1 } }] }) { __typename } }",
    );
    expect(plain().update({ a: 1 }).where({ t: { eq: 5 } }).or(orGroup).toGraphql().document).toContain("_or: [");
    expect(() => plain().delete().where({}).toGraphql()).toThrow(ConfigError);
    expect(() => plain().update({ a: 1 }).where({}).toGraphql()).toThrow(ConfigError);
    expect(() => plain().delete().toGraphql()).toThrow(ConfigError);
  });
  it("REST update and delete refuse an empty filter", async () => {
    await expect(asRest().delete().where({}).execute()).rejects.toBeInstanceOf(ConfigError);
    await expect(asRest().update({ a: 1 }).where({}).execute()).rejects.toBeInstanceOf(ConfigError);
  });
  it("throws when not is not an object with an operator", () => {
    for (const bad of [9, "x", null, [], {}]) {
      expect(() => asRest().where({ c: { not: bad } } as never).toRest()).toThrow(ConfigError);
      expect(() => plain().where({ c: { not: bad } } as never).toGraphql()).toThrow(ConfigError);
    }
  });
  it("throws on empty or non-object column filters on both transports", () => {
    for (const bad of [{}, 5, "x", null, []]) {
      expect(() => asRest().where({ c: bad } as never).toRest()).toThrow(ConfigError);
      expect(() => plain().where({ c: bad } as never).toGraphql()).toThrow(ConfigError);
    }
  });
  it("throws when _or is not a non-empty array of filters", () => {
    for (const bad of [5, "x", {}, [], [5], [{}]]) {
      expect(() => plain().where({ t: { eq: 1 }, _or: bad } as never).toGraphql()).toThrow(ConfigError);
      expect(() => plain().where({ t: { eq: 1 } }).or(bad as never).toGraphql()).toThrow(ConfigError);
      expect(() => asRest().where({ t: { eq: 1 }, _or: bad } as never).toRest()).toThrow(ConfigError);
    }
  });
  it("throws when both where._or and .or() are given", () => {
    const orGroup = [{ id: { eq: 1 } }] as WhereInput[];
    expect(() => plain().where({ t: { eq: 1 }, _or: orGroup } as never).or(orGroup).toGraphql()).toThrow(ConfigError);
  });
  it("throws for vector or aggregate over REST", () => {
    expect(() => asRest().vector({ column: "e", near: [1] }).toRest()).toThrow(ConfigError);
    expect(() => asRest().aggregate({ count: true }).toRest()).toThrow(ConfigError);
  });
  it("throws for vector combined with aggregate on GraphQL", () => {
    expect(() => plain().vector({ column: "e", near: [1] }).aggregate({ count: true }).toGraphql()).toThrow(ConfigError);
  });
});

/**
 * Every combination of condition-like modifiers, per transport and per kind of
 * call. The rule: each modifier that was set shows up in what is sent, or the
 * call throws. It is never silently dropped.
 */
describe("nothing is dropped: every combination", () => {
  type Mod = "where" | "or" | "orderBy" | "limit" | "offset" | "vector" | "aggregate";
  const MODS: Mod[] = ["where", "or", "orderBy", "limit", "offset", "vector", "aggregate"];
  type Kind = "read" | "count" | "insert" | "update" | "delete";
  const KINDS: Kind[] = ["read", "count", "insert", "update", "delete"];
  const EVIDENCE: Record<Mod, RegExp> = {
    where: /wcol/,
    or: /ocol/,
    orderBy: /ordcol/,
    limit: /limit[:=] ?77/,
    offset: /offset[:=] ?88/,
    vector: /vector:/,
    aggregate: /sum \{ amt \}/,
  };

  async function run(transport: "graphql" | "rest", kind: Kind, mods: Set<Mod>): Promise<string | "threw"> {
    const sent: string[] = [];
    const db = createClient<any>({ // eslint-disable-line @typescript-eslint/no-explicit-any
      ...base,
      fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
        sent.push(`${String(u)} ${String(init?.body ?? "")}`);
        return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    let b = db.from("users", { table: "users" }).via(transport);
    if (kind === "insert") b = b.insert({ a: 1 });
    if (kind === "update") b = b.update({ a: 1 });
    if (kind === "delete") b = b.delete();
    if (mods.has("where") || kind === "update" || kind === "delete") b = b.where({ wcol: { eq: 5 } });
    if (mods.has("or")) b = b.or([{ ocol: { eq: 1 } }] as WhereInput[]);
    if (mods.has("orderBy")) b = b.orderBy({ ordcol: "asc" });
    if (mods.has("limit")) b = b.limit(77);
    if (mods.has("offset")) b = b.offset(88);
    if (mods.has("vector")) b = b.vector({ column: "e", near: [1] });
    if (mods.has("aggregate")) b = b.aggregate({ sum: ["amt"] });
    try {
      if (kind === "read") await b.all();
      else if (kind === "count") await b.count();
      else await b.execute();
    } catch (e) {
      if (e instanceof ConfigError) return "threw";
      throw e;
    }
    return decodeURIComponent(sent.join("\n").replace(/\+/g, " "));
  }

  for (const transport of ["graphql", "rest"] as const) {
    for (const kind of KINDS) {
      it(`${transport} ${kind}: every set modifier is sent or the call throws`, async () => {
        const failures: string[] = [];
        for (let mask = 0; mask < 1 << MODS.length; mask++) {
          const mods = new Set(MODS.filter((_, i) => mask & (1 << i)));
          const out = await run(transport, kind, mods);
          if (out === "threw") continue;
          const required = new Set(mods);
          if (kind === "update" || kind === "delete") required.add("where");
          for (const m of required) {
            if (!EVIDENCE[m].test(out)) failures.push(`${[...mods].join("+") || "(none)"}: ${m} dropped`);
          }
        }
        expect(failures).toEqual([]);
      });
    }
  }
});

describe("first() leaves the builder unchanged", () => {
  it("lets count() run after first() on the same builder", async () => {
    const db = createClient<any>({ // eslint-disable-line @typescript-eslint/no-explicit-any
      ...base,
      fetch: (async () =>
        new Response(JSON.stringify({ data: { users: [], usersAggregate: { count: 3 } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    const q = db.from("users").where({ t: { eq: 5 } });
    await q.first();
    await expect(q.count()).resolves.toBe(3);
    expect(q.toGraphql().document).not.toContain("limit");
  });
});

describe("undefined is never turned into null", () => {
  const asRest = () => plain().via("rest");
  it("throws on undefined anywhere in a filter, on both transports", () => {
    expect(() => plain().where({ owner: { eq: undefined } } as never).toGraphql()).toThrow(ConfigError);
    expect(() => typed().where({ status: { eq: undefined } } as never).toGraphql()).toThrow(ConfigError);
    expect(() => plain().where({ owner: { in: [1, undefined] } } as never).toGraphql()).toThrow(ConfigError);
    expect(() => plain().where({ owner: { not: { eq: undefined } } } as never).toGraphql()).toThrow(ConfigError);
    expect(() => asRest().where({ owner: { eq: undefined } } as never).toRest()).toThrow(ConfigError);
    expect(() => asRest().where({ owner: { in: [1, undefined] } } as never).toRest()).toThrow(ConfigError);
    expect(() => asRest().where({ owner: { not: { eq: undefined } } } as never).toRest()).toThrow(ConfigError);
  });
  it("keeps an explicit null meaning IS NULL", () => {
    expect(plain().where({ owner: { eq: null } }).toGraphql().document).toContain("owner: { eq: null }");
  });
  it("drops undefined keys from insert and update rows on GraphQL, like REST does", () => {
    expect(plain().insert({ name: undefined, a: 1 }).toGraphql().document).toBe(
      "mutation { createUsers(input: { a: 1 }) { __typename } }",
    );
    expect(plain().insert([{ name: undefined, a: 1 }, { a: 2 }]).toGraphql().document).toContain("inputs: [{ a: 1 }, { a: 2 }]");
    expect(plain().update({ name: undefined, a: 1 }).where({ id: { eq: 1 } }).toGraphql().document).toContain("input: { a: 1 }");
  });
  it("sends REST bodies without undefined keys", async () => {
    const bodies: string[] = [];
    const db = createClient<any>({ // eslint-disable-line @typescript-eslint/no-explicit-any
      ...base,
      fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await db.from("users", { table: "users" }).via("rest").insert({ name: undefined, a: 1 }).execute();
    expect(JSON.parse(bodies[0]!)).toEqual({ a: 1 });
  });
  it("throws when an update has no defined values", () => {
    expect(() => plain().update({ name: undefined }).where({ id: { eq: 1 } }).toGraphql()).toThrow(ConfigError);
  });
});

describe("REST returning()", () => {
  it("throws and points to the GraphQL transport", async () => {
    const calls: string[] = [];
    const db = createClient<any>({ // eslint-disable-line @typescript-eslint/no-explicit-any
      ...base,
      fetch: (async (u: RequestInfo | URL) => {
        calls.push(String(u));
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    const q = db.from("users", { table: "users" }).via("rest").insert({ a: 1 }).returning("id");
    await expect(q.execute()).rejects.toThrow(/GraphQL/);
    expect(calls).toHaveLength(0);
  });
  it("still works over GraphQL", () => {
    expect(plain().insert({ a: 1 }).returning("id").toGraphql().document).toContain("{ id }");
  });
});

describe("REST rejects undefined nested inside values", () => {
  const asRest = () => plain().via("rest");
  it("throws for nested undefined in filter values", () => {
    expect(() => asRest().where({ m: { jsonContains: { tenant: undefined } } } as never).toRest()).toThrow(ConfigError);
    expect(() => asRest().where({ m: { containedBy: { a: [undefined] } } } as never).toRest()).toThrow(ConfigError);
    expect(() => asRest().where({ t: { arrayContains: [[undefined]] } } as never).toRest()).toThrow(ConfigError);
    expect(() => asRest().where({ m: { not: { jsonContains: { a: { b: undefined } } } } } as never).toRest()).toThrow(ConfigError);
  });
  it("still sends fully defined JSON filter values", () => {
    expect(decodeURIComponent(asRest().where({ m: { jsonContains: { a: [1, null] } } }).toRest().path)).toBe(
      '/users?m=jsoncontains.{"a":[1,null]}',
    );
  });
  it("throws for nested undefined in REST insert and update bodies, without sending", async () => {
    const calls: string[] = [];
    const db = createClient<any>({ // eslint-disable-line @typescript-eslint/no-explicit-any
      ...base,
      fetch: (async (u: RequestInfo | URL) => {
        calls.push(String(u));
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    const q = () => db.from("users", { table: "users" }).via("rest");
    await expect(q().update({ meta: { a: undefined } }).where({ id: { eq: 1 } }).execute()).rejects.toBeInstanceOf(ConfigError);
    await expect(q().insert({ meta: [undefined] }).execute()).rejects.toBeInstanceOf(ConfigError);
    await expect(q().insert([{ a: 1 }, { meta: { b: undefined } }]).execute()).rejects.toBeInstanceOf(ConfigError);
    expect(calls).toHaveLength(0);
  });
});
