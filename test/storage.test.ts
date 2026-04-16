import { memoryStorageAdapter, localStorageAdapter, defaultStorage } from "../src/storage";

describe("memoryStorageAdapter", () => {
  it("round-trips values", () => {
    const s = memoryStorageAdapter();
    expect(s.getItem("k")).toBeNull();
    s.setItem("k", "v");
    expect(s.getItem("k")).toBe("v");
    s.removeItem("k");
    expect(s.getItem("k")).toBeNull();
  });

  it("is isolated per instance", () => {
    const a = memoryStorageAdapter();
    const b = memoryStorageAdapter();
    a.setItem("k", "a");
    expect(b.getItem("k")).toBeNull();
  });
});

describe("localStorageAdapter", () => {
  afterEach(() => {
    delete (globalThis as unknown as { window?: object }).window;
  });

  it("throws when no browser environment is present", () => {
    expect(() => localStorageAdapter()).toThrow();
  });

  it("delegates to window.localStorage when available", () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    };
    const s = localStorageAdapter();
    s.setItem("k", "v");
    expect(s.getItem("k")).toBe("v");
    s.removeItem("k");
    expect(s.getItem("k")).toBeNull();
  });
});

describe("defaultStorage", () => {
  afterEach(() => {
    delete (globalThis as unknown as { window?: object }).window;
  });

  it("returns memory storage in node", () => {
    const s = defaultStorage();
    s.setItem("x", "y");
    expect(s.getItem("x")).toBe("y");
  });

  it("returns localStorage-backed adapter in browser", () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    };
    const s = defaultStorage();
    s.setItem("a", "b");
    expect(store.get("a")).toBe("b");
  });
});
