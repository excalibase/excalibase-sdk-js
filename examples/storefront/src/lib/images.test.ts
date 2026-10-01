import { describe, expect, it } from "vitest";
import { createImageUrlLoader } from "./images";

const A = "kg2_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "kg2_bbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("product picture links", () => {
  it("asks for every picture on a page in one call", async () => {
    const calls: string[][] = [];
    const load = createImageUrlLoader(async (ids) => {
      calls.push(ids);
      return Object.fromEntries(ids.map((id) => [id, `https://files.test/${id}`]));
    });
    const [a, b, again] = await Promise.all([load(A), load(B), load(A)]);
    expect(calls).toEqual([[A, B]]);
    expect([a, b, again]).toEqual([`https://files.test/${A}`, `https://files.test/${B}`, `https://files.test/${A}`]);
  });

  it("is null for a picture the project does not have", async () => {
    const load = createImageUrlLoader(async () => ({ [A]: null }));
    expect(await load(A)).toBeNull();
    expect(await load(B)).toBeNull();
  });

  it("fails every waiting picture when the call fails, and tries again later", async () => {
    let fail = true;
    const load = createImageUrlLoader(async (ids) => {
      if (fail) throw new Error("down");
      return Object.fromEntries(ids.map((id) => [id, "ok"]));
    });
    await expect(Promise.all([load(A), load(B)])).rejects.toThrow("down");
    fail = false;
    expect(await load(A)).toBe("ok");
  });
});
