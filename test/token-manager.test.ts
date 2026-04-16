import { TokenManager, computeExpiresAt } from "../src/token-manager";
import type { Session } from "../src/types";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    accessToken: "at-1",
    refreshToken: "rt-1",
    tokenType: "Bearer",
    expiresAt: 10_000_000,
    user: null,
    ...overrides,
  };
}

describe("computeExpiresAt", () => {
  it("adds seconds to now", () => {
    expect(computeExpiresAt(3600, 1_000_000)).toBe(1_000_000 + 3_600_000);
  });

  it("clamps negative expiresIn to 0", () => {
    expect(computeExpiresAt(-5, 1_000)).toBe(1_000);
  });
});

describe("TokenManager", () => {
  type Timer = { fn: () => void; ms: number };

  function makeClock() {
    let current = 1_000_000;
    const timers: Timer[] = [];
    return {
      now: () => current,
      advance: (ms: number) => {
        current += ms;
        const ready = timers.splice(0);
        for (const t of ready) t.fn();
      },
      setTimeout: (fn: () => void, ms: number) => {
        const t: Timer = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimeout: (handle: unknown) => {
        const idx = timers.indexOf(handle as Timer);
        if (idx >= 0) timers.splice(idx, 1);
      },
      hasTimers: () => timers.length > 0,
    };
  }

  it("schedules a refresh at (expiresAt - leadTime)", async () => {
    const clock = makeClock();
    const refresh = jest.fn<Promise<Session | null>, []>().mockResolvedValue(makeSession({ accessToken: "at-2" }));
    const onRefreshed = jest.fn();

    const tm = new TokenManager({
      session: makeSession({ expiresAt: clock.now() + 3_600_000 }),
      refresh,
      onRefreshed,
      leadTimeMs: 60_000,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    tm.start();

    expect(refresh).not.toHaveBeenCalled();
    // Advance to the scheduled fire time: 3600s - 60s = 3540s.
    clock.advance(3_540_000);
    // The refresh callback is async — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onRefreshed).toHaveBeenCalledTimes(1);
    expect(onRefreshed).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "at-2" }));
  });

  it("stops rescheduling after stop()", () => {
    const clock = makeClock();
    const tm = new TokenManager({
      session: makeSession({ expiresAt: clock.now() + 1_000_000 }),
      refresh: jest.fn(),
      leadTimeMs: 0,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    tm.start();
    expect(clock.hasTimers()).toBe(true);
    tm.stop();
    expect(clock.hasTimers()).toBe(false);
  });

  it("does not schedule when session is null", () => {
    const clock = makeClock();
    const tm = new TokenManager({
      session: null,
      refresh: jest.fn(),
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    tm.start();
    expect(clock.hasTimers()).toBe(false);
  });

  it("reschedules after refresh resolves", async () => {
    const clock = makeClock();
    const refresh = jest
      .fn<Promise<Session | null>, []>()
      .mockResolvedValueOnce(makeSession({ expiresAt: clock.now() + 7_200_000, accessToken: "at-2" }))
      .mockResolvedValue(makeSession({ expiresAt: clock.now() + 7_200_000, accessToken: "at-3" }));

    const tm = new TokenManager({
      session: makeSession({ expiresAt: clock.now() + 3_600_000 }),
      refresh,
      leadTimeMs: 60_000,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    tm.start();

    clock.advance(3_540_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    // A new timer should be queued for the next refresh cycle.
    expect(clock.hasTimers()).toBe(true);
  });

  it("invokes onError and does NOT reschedule when refresh throws", async () => {
    const clock = makeClock();
    const boom = new Error("network");
    const refresh = jest.fn<Promise<Session | null>, []>().mockRejectedValue(boom);
    const onError = jest.fn();

    const tm = new TokenManager({
      session: makeSession({ expiresAt: clock.now() + 3_600_000 }),
      refresh,
      onError,
      leadTimeMs: 60_000,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    tm.start();

    clock.advance(3_540_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(clock.hasTimers()).toBe(false);
  });

  it("does not schedule before start() is called (prevents timer leaks)", () => {
    const clock = makeClock();
    const tm = new TokenManager({
      session: makeSession({ expiresAt: clock.now() + 3_600_000 }),
      refresh: jest.fn(),
      leadTimeMs: 60_000,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    tm.setSession(makeSession({ expiresAt: clock.now() + 3_600_000 }));
    expect(clock.hasTimers()).toBe(false);
  });

  it("setSession replaces the scheduled timer", () => {
    const clock = makeClock();
    const tm = new TokenManager({
      session: makeSession({ expiresAt: clock.now() + 3_600_000 }),
      refresh: jest.fn(),
      leadTimeMs: 60_000,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    tm.start();
    expect(clock.hasTimers()).toBe(true);

    tm.setSession(makeSession({ expiresAt: clock.now() + 7_200_000, accessToken: "at-new" }));
    expect(clock.hasTimers()).toBe(true);
    expect(tm.getSession()?.accessToken).toBe("at-new");

    tm.setSession(null);
    expect(clock.hasTimers()).toBe(false);
    expect(tm.getSession()).toBeNull();
  });
});
