/**
 * EXC-640: a function is reached at /functions/v1/{projectId}/{id}. Its id
 * may be one segment (`invite`, as deploy_function and Studio name them) or
 * `module.export`; `db.functions.<id>(args)` calls the first, and
 * `db.functions.<a>.<b>(args)` keeps calling the id `a.b`.
 */

import { describe, test, expect } from "@jest/globals";
import { createClient } from "../src";
import { memoryStorageAdapter } from "../src/storage";

function recordingFetch(answer: unknown) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function client(fetchImpl: typeof fetch) {
  return createClient({
    url: "http://api.test",
    projectId: "proj_abc",
    publishableKey: "esk_pub_test_0123456789",
    fetch: fetchImpl,
    storage: memoryStorageAdapter(),
  });
}

describe("db.functions by id", () => {
  test("db.functions.<id>(args) posts {args} to the function's own route", async () => {
    const { fetchImpl, calls } = recordingFetch({ data: { token: "t1" } });
    const db = client(fetchImpl);
    const out = await db.functions.invite({ action: "create", workspace_id: 1 });
    expect(out).toEqual({ token: "t1" });
    expect(calls).toEqual([
      { url: "http://api.test/functions/v1/proj_abc/invite", body: { args: { action: "create", workspace_id: 1 } } },
    ]);
  });

  test("db.functions.<a>.<b>(args) still calls the function whose id is a.b", async () => {
    const { fetchImpl, calls } = recordingFetch({ data: [] });
    await client(fetchImpl).functions.images.urls({ ids: [1] });
    expect(calls[0].url).toBe("http://api.test/functions/v1/proj_abc/images.urls");
  });

  test("an id is path-encoded", async () => {
    const { fetchImpl, calls } = recordingFetch({ data: null });
    await client(fetchImpl).functions["a b"]({});
    expect(calls[0].url).toBe("http://api.test/functions/v1/proj_abc/a%20b");
  });
});
