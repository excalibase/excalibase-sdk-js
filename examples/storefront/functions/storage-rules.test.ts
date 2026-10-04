import { describe, expect, it } from "vitest";
import { imageIdsRefusal, productImageRefusal, staffRefusal, uniqueImageIds } from "./storage-rules";

const staff = { role: "staff", allowed_roles: ["staff", "user"] };
const customer = { role: "user", allowed_roles: ["user"] };

describe("who may upload product images", () => {
  it("lets staff upload a picture", () => {
    expect(productImageRefusal(staff, "image/png", 4096)).toBeUndefined();
    expect(productImageRefusal(staff, "image/jpeg", 5 * 1024 * 1024)).toBeUndefined();
    expect(staffRefusal(staff)).toBeUndefined();
  });

  it("refuses a signed-in customer with 403", () => {
    const forbidden = { status: 403, message: "only staff may upload product images" };
    expect(productImageRefusal(customer, "image/png", 4096)).toEqual(forbidden);
    expect(staffRefusal(customer)).toEqual(forbidden);
    expect(staffRefusal({ allowed_roles: ["staff"] })).toEqual(forbidden);
  });

  it("refuses a caller without a verified token with 401", () => {
    expect(productImageRefusal(null, "image/png", 4096)).toEqual({ status: 401, message: "sign in to upload product images" });
    expect(staffRefusal(undefined)?.status).toBe(401);
  });

  it("takes pictures only, up to 5 MB, refusing anything else with 400", () => {
    expect(productImageRefusal(staff, "image/svg+xml", 4096)).toEqual({ status: 400, message: "a product image is a png, jpeg, webp or gif file" });
    expect(productImageRefusal(staff, "text/html", 4096)?.status).toBe(400);
    expect(productImageRefusal(staff, "image/png", 5 * 1024 * 1024 + 1)).toEqual({ status: 400, message: "a product image is at most 5 MB" });
    expect(productImageRefusal(staff, "image/png", 0)?.status).toBe(400);
  });
});

describe("which image links a caller may ask for", () => {
  it("accepts storage ids, once each", () => {
    const id = "kg2_0123456789abcdef0123456789";
    expect(imageIdsRefusal([id, id])).toBeUndefined();
    expect(uniqueImageIds([id, id])).toEqual([id]);
  });

  it("refuses anything that is not a storage id, and too many at once, with 400", () => {
    expect(imageIdsRefusal(["../etc/passwd"])).toEqual({ status: 400, message: "not a storage id" });
    expect(imageIdsRefusal("kg2_0123456789abcdef0123456789")).toEqual({ status: 400, message: "storageIds must be a list" });
    const many = Array.from({ length: 101 }, (_, i) => `kg2_${i.toString(16).padStart(26, "0")}`);
    expect(imageIdsRefusal(many)).toEqual({ status: 400, message: "at most 100 images at once" });
  });
});
