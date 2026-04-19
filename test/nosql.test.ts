import { describe, test, expect, beforeEach } from "@jest/globals";
import { defineSchema, defineCollection, CollectionClient, NoSqlNamespace } from "../src/nosql";

describe("defineSchema / defineCollection", () => {
  test("defineCollection returns the definition", () => {
    const col = defineCollection({
      fields: { email: "string", age: "number" },
      indexes: [{ fields: ["email"], unique: true }],
    });
    expect(col.fields.email).toBe("string");
    expect(col.indexes).toHaveLength(1);
    expect(col.indexes[0].unique).toBe(true);
  });

  test("defineSchema wraps collections", () => {
    const schema = defineSchema({
      users: defineCollection({
        fields: { email: "string" },
        indexes: [{ fields: ["email"], unique: true }],
      }),
    });
    expect(schema.collections.users).toBeDefined();
    expect(schema.collections.users.indexes[0].fields).toEqual(["email"]);
  });
});

describe("CollectionClient", () => {
  let lastRequest: { url: string; method: string; body: unknown } | null;
  let mockResponse: { ok: boolean; status: number; data: unknown };

  const mockFetch = (async (url: string, init?: RequestInit) => {
    lastRequest = {
      url: url as string,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : null,
    };
    return {
      ok: mockResponse.ok,
      status: mockResponse.status,
      json: async () => mockResponse.data,
    };
  }) as unknown as typeof fetch;

  let client: CollectionClient;

  beforeEach(() => {
    lastRequest = null;
    mockResponse = { ok: true, status: 200, data: { data: [] } };
    client = new CollectionClient("http://localhost/api/v1/nosql", "users", mockFetch, {});
  });

  test("find sends GET with filter params", async () => {
    mockResponse = { ok: true, status: 200, data: { data: [{ id: "1", name: "Vu" }] } };
    const result = await client.find({ status: "active" }, { limit: 10 });

    expect(lastRequest?.url).toContain("/users?");
    expect(lastRequest?.url).toContain("status=eq.active");
    expect(lastRequest?.url).toContain("limit=10");
    expect(lastRequest?.method).toBe("GET");
    expect(result).toEqual([{ id: "1", name: "Vu" }]);
  });

  test("findOne sends GET with limit=1", async () => {
    mockResponse = { ok: true, status: 200, data: { data: [{ id: "1", email: "vu@test.com" }] } };
    const result = await client.findOne({ email: "vu@test.com" });

    expect(lastRequest?.url).toContain("email=eq.vu@test.com");
    expect(lastRequest?.url).toContain("limit=1");
    expect(result).toEqual({ id: "1", email: "vu@test.com" });
  });

  test("findOne returns null on empty result", async () => {
    mockResponse = { ok: true, status: 200, data: { data: [] } };
    const result = await client.findOne({ email: "missing@test.com" });
    expect(result).toBeNull();
  });

  test("getById sends GET to /users/:id", async () => {
    mockResponse = { ok: true, status: 200, data: { data: { id: "abc", name: "Vu" } } };
    const result = await client.getById("abc");

    expect(lastRequest?.url).toBe("http://localhost/api/v1/nosql/users/abc");
    expect(lastRequest?.method).toBe("GET");
    expect(result).toEqual({ id: "abc", name: "Vu" });
  });

  test("insertOne sends POST with doc", async () => {
    mockResponse = { ok: true, status: 201, data: { data: { id: "new", name: "Vu" } } };
    const result = await client.insertOne({ name: "Vu", email: "vu@test.com" });

    expect(lastRequest?.url).toBe("http://localhost/api/v1/nosql/users");
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.body).toEqual({ doc: { name: "Vu", email: "vu@test.com" } });
    expect(result).toEqual({ id: "new", name: "Vu" });
  });

  test("updateOne sends PATCH with filter params", async () => {
    mockResponse = { ok: true, status: 200, data: { data: [{ id: "1", status: "inactive" }], modified: 1 } };
    const result = await client.updateOne({ email: "vu@test.com" }, { $set: { status: "inactive" } });

    expect(lastRequest?.url).toContain("email=eq.vu@test.com");
    expect(lastRequest?.method).toBe("PATCH");
    expect(result).toEqual({ id: "1", status: "inactive" });
  });

  test("deleteOne sends DELETE with filter params", async () => {
    mockResponse = { ok: true, status: 200, data: { data: [{ id: "1", name: "Vu" }], deleted: 1 } };
    const result = await client.deleteOne({ email: "vu@test.com" });

    expect(lastRequest?.url).toContain("email=eq.vu@test.com");
    expect(lastRequest?.method).toBe("DELETE");
    expect(result).toEqual({ id: "1", name: "Vu" });
  });

  test("count sends GET with count param", async () => {
    mockResponse = { ok: true, status: 200, data: { data: { count: 42 } } };
    const result = await client.count({ status: "active" });

    expect(lastRequest?.url).toContain("count");
    expect(lastRequest?.url).toContain("status=eq.active");
    expect(result).toBe(42);
  });

  test("search sends GET with search param", async () => {
    mockResponse = { ok: true, status: 200, data: { data: [{ id: "1", body: "hello" }] } };
    const result = await client.search("hello world", { limit: 5 });

    expect(lastRequest?.url).toContain("search=hello%20world");
    expect(lastRequest?.url).toContain("limit=5");
    expect(lastRequest?.method).toBe("GET");
    expect(result).toHaveLength(1);
  });

  test("vectorSearch sends POST with vector=true", async () => {
    mockResponse = { ok: true, status: 200, data: { data: [{ id: "1" }] } };
    const result = await client.vectorSearch([0.1, 0.2, 0.3], { topK: 3 });

    expect(lastRequest?.url).toContain("vector=true");
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.body).toEqual({ embedding: [0.1, 0.2, 0.3], topK: 3 });
    expect(result).toHaveLength(1);
  });

  test("insertMany sends POST with docs array", async () => {
    mockResponse = { ok: true, status: 201, data: { data: [{ id: "1" }, { id: "2" }] } };
    const result = await client.insertMany([{ name: "A" }, { name: "B" }]);

    expect(lastRequest?.url).toBe("http://localhost/api/v1/nosql/users");
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.body).toEqual({ docs: [{ name: "A" }, { name: "B" }] });
    expect(result).toHaveLength(2);
  });
});

describe("NoSqlNamespace", () => {
  let lastRequest: { url: string; method: string; body: unknown } | null;

  const mockFetch = (async (url: string, init?: RequestInit) => {
    lastRequest = {
      url: url as string,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : null,
    };
    return { ok: true, status: 200, json: async () => ({ data: {} }) };
  }) as unknown as typeof fetch;

  test("init sends schema to /api/v1/nosql", async () => {
    const ns = new NoSqlNamespace("http://localhost", mockFetch, {});
    await ns.init(
      defineSchema({
        users: defineCollection({
          fields: { email: "string" },
          indexes: [{ fields: ["email"], unique: true }],
        }),
      }),
    );

    expect(lastRequest?.url).toBe("http://localhost/api/v1/nosql");
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.body).toHaveProperty("collections.users");
  });

  test("collection returns CollectionClient", () => {
    const ns = new NoSqlNamespace("http://localhost", mockFetch, {});
    const col = ns.collection("users");
    expect(col).toBeInstanceOf(CollectionClient);
  });
});
