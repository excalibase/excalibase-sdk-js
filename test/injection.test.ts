import { createClient, str, unquoted, ConfigError } from "../src";
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
  it("double-quotes in values that contain separators, parens, quotes or spaces", () => {
    expect(rest({ s: { in: ["a,b", 'c"d', "e f", "(g)"] } })).toBe('/users?s=in.("a,b","c\\"d","e+f","(g)")');
    expect(rest({ s: { notIn: ["a,b"] } })).toBe('/users?s=not.in.("a,b")');
  });
  it("cannot smuggle an extra list member or filter through an in value", () => {
    const path = plain().where({ s: { in: ["x),status.eq.admin,(y"] } }).toRest().path;
    expect(decodeURIComponent(path)).toBe('/users?s=in.("x),status.eq.admin,(y")');
  });
  it("quotes array filter values the same way", () => {
    expect(rest({ t: { arrayContains: ["bug", "a,b", "}x"] } })).toBe('/users?t=cs.{bug,"a,b","}x"}');
    expect(rest({ t: { hasKeys: ["k", "a,b"] } })).toBe('/users?t=haskeys.(k,"a,b")');
  });
  it("maps contains to ilike with %...%", () => {
    expect(rest({ title: { contains: "foo" } })).toBe("/users?title=ilike.%foo%");
  });
  it("escapes LIKE wildcards inside contains", () => {
    expect(rest({ title: { contains: "50%_" } })).toBe("/users?title=ilike.%50\\%\\_%");
  });
  it("applies the same escaping to REST mutations' where", async () => {
    const calls: string[] = [];
    const db = createClient<any>({ // eslint-disable-line @typescript-eslint/no-explicit-any
      ...base,
      fetch: (async (u: RequestInfo | URL) => {
        calls.push(String(u));
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await db.from("users", { table: "users" }).via("rest").delete().where({ s: { in: ["a,b"] } }).execute();
    expect(decodeURIComponent(calls[0]!)).toContain('s=in.("a,b")');
  });
});
