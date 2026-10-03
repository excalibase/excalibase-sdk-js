import { describe, expect, it } from "vitest";
import { checkProductImageUpload, checkStaff, requestedImageIds } from "./storage-rules";

const staff = { role: "staff", allowed_roles: ["staff", "user"] };
const customer = { role: "user", allowed_roles: ["user"] };

describe("who may upload product images", () => {
  it("lets staff upload a picture", () => {
    expect(() => checkProductImageUpload(staff, "image/png", 4096)).not.toThrow();
    expect(() => checkProductImageUpload(staff, "image/jpeg", 5 * 1024 * 1024)).not.toThrow();
  });

  it("refuses a customer, a guest and a token the gateway did not verify", () => {
    expect(() => checkProductImageUpload(customer, "image/png", 4096)).toThrow(/only staff/);
    expect(() => checkProductImageUpload(null, "image/png", 4096)).toThrow(/only staff/);
    expect(() => checkStaff({ allowed_roles: ["staff"] })).toThrow(/only staff/);
  });

  it("takes pictures only, up to 5 MB", () => {
    expect(() => checkProductImageUpload(staff, "image/svg+xml", 4096)).toThrow(/png, jpeg, webp or gif/);
    expect(() => checkProductImageUpload(staff, "text/html", 4096)).toThrow(/png, jpeg, webp or gif/);
    expect(() => checkProductImageUpload(staff, "image/png", 5 * 1024 * 1024 + 1)).toThrow(/5 MB/);
    expect(() => checkProductImageUpload(staff, "image/png", 0)).toThrow(/5 MB/);
  });
});

describe("which image links a caller may ask for", () => {
  it("accepts storage ids, once each", () => {
    const id = "kg2_0123456789abcdef0123456789";
    expect(requestedImageIds([id, id])).toEqual([id]);
  });

  it("refuses anything that is not a storage id, and too many at once", () => {
    expect(() => requestedImageIds(["../etc/passwd"])).toThrow(/storage id/);
    expect(() => requestedImageIds("kg2_0123456789abcdef0123456789")).toThrow(/list/);
    const many = Array.from({ length: 101 }, (_, i) => `kg2_${i.toString(16).padStart(26, "0")}`);
    expect(() => requestedImageIds(many)).toThrow(/at most 100/);
  });
});
