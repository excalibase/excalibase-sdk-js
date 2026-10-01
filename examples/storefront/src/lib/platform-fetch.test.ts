import { describe, expect, it, vi } from "vitest";
import { platformFetch } from "./platform-fetch";

const DATA = "https://api.example.test";

function capture() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const inner = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response("{}");
  });
  return { calls, fetch: platformFetch({ dataUrl: DATA, orgSlug: "acme", projectId: "proj-1" }, inner as typeof fetch) };
}

describe("platformFetch", () => {
  it("puts the project in front of GraphQL and REST", async () => {
    const { calls, fetch } = capture();
    await fetch(`${DATA}/graphql`, { method: "POST" });
    await fetch(`${DATA}/api/v1/products?select=id`);
    expect(calls.map((c) => c.url)).toEqual([
      `${DATA}/proj-1/graphql`,
      `${DATA}/proj-1/api/v1/products?select=id`,
    ]);
  });

  it("leaves end-user auth where the SDK puts it", async () => {
    const { calls, fetch } = capture();
    await fetch(`${DATA}/auth/acme/proj-1/token`, { method: "POST" });
    expect(calls[0].url).toBe(`${DATA}/auth/acme/proj-1/token`);
  });

  it("names functions by project id only", async () => {
    const { calls, fetch } = capture();
    await fetch(`${DATA}/functions/v1/acme/proj-1/system.generateUploadUrl`, { method: "POST" });
    expect(calls[0].url).toBe(`${DATA}/functions/v1/proj-1/system.generateUploadUrl`);
  });

  it("passes other hosts through untouched", async () => {
    const { calls, fetch } = capture();
    await fetch("https://files.example.test/upload?sig=1", { method: "PUT" });
    expect(calls[0].url).toBe("https://files.example.test/upload?sig=1");
  });

  it("keeps the request's method, headers and body", async () => {
    const { calls, fetch } = capture();
    const init = { method: "POST", headers: { Authorization: "Bearer t" }, body: "{}" };
    await fetch(`${DATA}/graphql`, init);
    expect(calls[0].init).toBe(init);
  });
});
