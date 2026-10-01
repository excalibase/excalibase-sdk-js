import { describe, expect, it } from "vitest";
import { decimal, int, str } from "./gql";

describe("GraphQL literals", () => {
  it("quotes and escapes strings", () => {
    expect(str('gift "wrap"\nplease')).toBe('"gift \\"wrap\\"\\nplease"');
  });

  it("accepts integers only", () => {
    expect(int(3)).toBe("3");
    expect(() => int(1.5)).toThrow();
    expect(() => int(Number.NaN)).toThrow();
    expect(() => int("1) { evil }" as unknown as number)).toThrow();
  });

  it("writes prices with two decimals and refuses negatives", () => {
    expect(decimal(12)).toBe("12.00");
    expect(decimal(35.5)).toBe("35.50");
    expect(() => decimal(-1)).toThrow();
  });
});
