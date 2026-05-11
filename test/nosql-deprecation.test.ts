/**
 * Phase 2: `db.nosql.collection(...)` is being deprecated in favour of
 * `db.functions.<module>.<name>(args)`. We don't remove it yet (that's
 * Phase 4) — we emit a console.warn exactly once per process so users see
 * the migration path without spamming logs.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { resetNoSqlDeprecationWarning } from "../src/nosql";
import { createClient } from "../src";
import { memoryStorageAdapter } from "../src/storage";

describe("db.nosql.collection deprecation warning", () => {
  let warnSpy: jest.Spied<typeof console.warn>;
  beforeEach(() => {
    resetNoSqlDeprecationWarning();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("warns exactly once across N calls to db.nosql.collection", () => {
    const db = createClient({
      url: "http://localhost:10000",
      projectId: "acme/prod",
      publishableKey: "esk_pub_live_abcdefghijklmnop",
      storage: memoryStorageAdapter(),
      autoRefreshToken: false,
    });
    db.nosql.collection("users");
    db.nosql.collection("posts");
    db.nosql.collection("comments");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]![0];
    expect(typeof msg).toBe("string");
    expect((msg as string).toLowerCase()).toContain("deprecated");
    // The warning must include the migration path to db.functions.
    expect((msg as string)).toMatch(/db\.functions/);
  });

  test("db.collection(name) also warns (top-level shortcut)", () => {
    const db = createClient({
      url: "http://localhost:10000",
      projectId: "acme/prod",
      publishableKey: "esk_pub_live_abcdefghijklmnop",
      storage: memoryStorageAdapter(),
      autoRefreshToken: false,
    });
    db.collection("widgets");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
