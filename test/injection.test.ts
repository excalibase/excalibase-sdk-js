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
