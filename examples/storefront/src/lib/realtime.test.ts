import { describe, expect, it } from "vitest";
import { toOrderChange } from "./realtime";

describe("toOrderChange", () => {
  it("takes the new row of an update", () => {
    expect(toOrderChange({ operation: "UPDATE", data: { old: { id: 1, status: "placed" }, new: { id: 1, status: "shipped" } } }))
      .toEqual({ operation: "UPDATE", row: { id: 1, status: "shipped" } });
  });

  it("takes the row of an insert, and the old row of a delete", () => {
    expect(toOrderChange({ operation: "INSERT", data: { id: 2, status: "placed" } })?.row.id).toBe(2);
    expect(toOrderChange({ operation: "DELETE", data: { old: { id: 3 } } })?.row.id).toBe(3);
  });

  it("ignores a change without a row", () => {
    expect(toOrderChange({ operation: "UPDATE", data: {} })).toBeNull();
  });
});
