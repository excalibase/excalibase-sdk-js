import { describe, expect, it } from "vitest";
import { claimsOf, roleOf } from "./token";

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const tokenFor = (claims: object) => `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;

describe("token claims", () => {
  it("reads the role a token runs as", () => {
    expect(roleOf(tokenFor({ role: "staff", allowed_roles: ["staff", "user"], userId: 7 }))).toBe("staff");
    expect(claimsOf(tokenFor({ email: "sam@example.test", userId: 7 }))).toMatchObject({ email: "sam@example.test", userId: 7 });
  });

  it("is anon without a token", () => {
    expect(roleOf(null)).toBe("anon");
  });

  it("is anon for a token it cannot read", () => {
    expect(roleOf("not-a-jwt")).toBe("anon");
    expect(roleOf(`a.${Buffer.from("{nope").toString("base64url")}.c`)).toBe("anon");
  });
});
