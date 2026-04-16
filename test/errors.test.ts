import { AuthError, ConfigError, ExcalibaseError, NetworkError } from "../src/errors";

describe("error classes", () => {
  it("ExcalibaseError carries code, status, cause", () => {
    const cause = new Error("underlying");
    const e = new ExcalibaseError("boom", "custom", 500, cause);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ExcalibaseError);
    expect(e.message).toBe("boom");
    expect(e.code).toBe("custom");
    expect(e.status).toBe(500);
    expect(e.cause).toBe(cause);
    expect(e.name).toBe("ExcalibaseError");
  });

  it("AuthError extends ExcalibaseError", () => {
    const e = new AuthError("unauthorized", "http_401", 401);
    expect(e).toBeInstanceOf(ExcalibaseError);
    expect(e).toBeInstanceOf(AuthError);
    expect(e.code).toBe("http_401");
    expect(e.status).toBe(401);
    expect(e.name).toBe("AuthError");
  });

  it("NetworkError uses network_error code", () => {
    const cause = new Error("econnreset");
    const e = new NetworkError("down", cause);
    expect(e).toBeInstanceOf(ExcalibaseError);
    expect(e.code).toBe("network_error");
    expect(e.cause).toBe(cause);
    expect(e.name).toBe("NetworkError");
  });

  it("ConfigError uses config_error code", () => {
    const e = new ConfigError("missing projectId");
    expect(e).toBeInstanceOf(ExcalibaseError);
    expect(e.code).toBe("config_error");
    expect(e.name).toBe("ConfigError");
  });
});
