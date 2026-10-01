import { describe, expect, it } from "vitest";
import { lineTotal, money, sumLines } from "./money";

describe("money", () => {
  it("adds lines in cents, so 0.1 + 0.2 is 0.30", () => {
    expect(sumLines([{ price: 0.1, quantity: 1 }, { price: 0.2, quantity: 1 }])).toBe(30);
    expect(lineTotal({ price: "19.99", quantity: 3 })).toBe(5997);
  });

  it("formats cents and decimal strings", () => {
    expect(money(5997)).toBe("$59.97");
    expect(money("89.00", { decimal: true })).toBe("$89.00");
  });
});
