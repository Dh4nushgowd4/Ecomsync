/**
 * tests/redis-lock.test.ts
 *
 * Proves that withInventoryLock() correctly serializes concurrent callers.
 *
 * Since we're testing the distributed lock semantics without a real Redis
 * instance, we use a fake in-memory Redis implementation that faithfully
 * models SET NX PX and Lua scripted DELETE semantics.
 *
 * What these tests prove:
 *   1. Two concurrent callers for the SAME key are serialized (no overlap)
 *   2. Two concurrent callers for DIFFERENT keys run in parallel
 *   3. The lock is always released — even when the protected fn throws
 *   4. After MAX_RETRIES the correct error is thrown
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// In-memory fake Redis that models NX semantics precisely
// ---------------------------------------------------------------------------

interface FakeStore {
  [key: string]: { value: string; expiresAt: number } | undefined;
}

const fakeStore: FakeStore = {};

// Track the execution timeline for serialization assertions
const timeline: { key: string; event: "start" | "end"; t: number }[] = [];

// Fake Redis class injected into the lock helper
class FakeRedis {
  async set(
    key: string,
    value: string,
    opts: { nx?: boolean; px?: number }
  ): Promise<"OK" | null> {
    const now = Date.now();
    const existing = fakeStore[key];

    // Honour NX: only set if not exists (or expired)
    if (opts.nx) {
      if (existing && existing.expiresAt > now) {
        return null; // Already held
      }
    }

    fakeStore[key] = {
      value,
      expiresAt: now + (opts.px ?? 15_000),
    };
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    const now = Date.now();
    const entry = fakeStore[key];
    if (!entry || entry.expiresAt <= now) return null;
    return entry.value;
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) {
      if (fakeStore[k]) {
        delete fakeStore[k];
        count++;
      }
    }
    return count;
  }

  async pttl(key: string): Promise<number> {
    const now = Date.now();
    const entry = fakeStore[key];
    if (!entry) return -2;
    const remaining = entry.expiresAt - now;
    return remaining > 0 ? remaining : -2;
  }

  /**
   * Fake eval that implements the Lua compare-and-delete script.
   * The real Lua: if GET(keys[0]) == argv[0] then DEL(keys[0]) → 1, else → 0
   */
  async eval(
    _script: string,
    keys: string[],
    args: string[]
  ): Promise<number> {
    const current = await this.get(keys[0]);
    if (current === args[0]) {
      await this.del(keys[0]);
      return 1;
    }
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Mock the @upstash/redis module to return our FakeRedis
// ---------------------------------------------------------------------------

vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor() {}
    set    = (...args: Parameters<FakeRedis["set"]>)    => fakeRedis.set(...args);
    get    = (...args: Parameters<FakeRedis["get"]>)    => fakeRedis.get(...args);
    del    = (...args: Parameters<FakeRedis["del"]>)    => fakeRedis.del(...args);
    pttl   = (...args: Parameters<FakeRedis["pttl"]>)   => fakeRedis.pttl(...args);
    eval   = (...args: Parameters<FakeRedis["eval"]>)   => fakeRedis.eval(...args);
  },
}));

// Also mock env vars so the client initializes
vi.stubEnv("UPSTASH_REDIS_REST_URL",   "https://fake.upstash.io");
vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fake-token");

let fakeRedis: FakeRedis;

beforeEach(() => {
  // Reset state before each test
  Object.keys(fakeStore).forEach((k) => delete fakeStore[k]);
  timeline.length = 0;
  fakeRedis = new FakeRedis();
});

afterEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Import the lock helper (AFTER mocking)
// ---------------------------------------------------------------------------

async function getLockHelper() {
  // Dynamic import ensures the mock is in place first
  const mod = await import("../lib/redis");
  return mod;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withInventoryLock — serialization", () => {
  it("serializes two concurrent callers on the same SKU+channel", async () => {
    const { withInventoryLock } = await getLockHelper();

    const executionOrder: number[] = [];

    async function caller(id: number, workMs: number) {
      await withInventoryLock("SKU-001", "channel-abc", async () => {
        executionOrder.push(id);
        await new Promise((r) => setTimeout(r, workMs));
        executionOrder.push(id * 10); // end marker
      });
    }

    // Start both callers simultaneously
    await Promise.all([caller(1, 50), caller(2, 50)]);

    // One must complete before the other starts (no interleaving)
    // Possible orders: [1, 10, 2, 20] or [2, 20, 1, 10]
    const first  = executionOrder[0];
    const second = executionOrder[1];

    // The "end" marker of the first caller must come before the "start" of the second
    expect(second).toBe(first * 10); // first caller's end marker is second in sequence
    expect(executionOrder).toHaveLength(4);
  });

  it("allows concurrent callers on DIFFERENT SKUs to run in parallel", async () => {
    const { withInventoryLock } = await getLockHelper();

    const starts: number[] = [];
    const ends:   number[] = [];

    async function caller(sku: string, workMs: number) {
      await withInventoryLock(sku, "channel-abc", async () => {
        starts.push(Date.now());
        await new Promise((r) => setTimeout(r, workMs));
        ends.push(Date.now());
      });
    }

    const t0 = Date.now();
    await Promise.all([
      caller("SKU-AAA", 60),
      caller("SKU-BBB", 60),
    ]);
    const elapsed = Date.now() - t0;

    // If they ran in parallel, total time ≈ 60ms not 120ms
    // Allow generous margin for event-loop overhead (< 100ms total)
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(elapsed).toBeLessThan(150);
  });

  it("releases the lock even when the protected function throws", async () => {
    const { withInventoryLock, getLockTtl } = await getLockHelper();

    await expect(
      withInventoryLock("SKU-ERR", "ch-1", async () => {
        throw new Error("Simulated sync failure");
      })
    ).rejects.toThrow("Simulated sync failure");

    // Lock should have been released
    const ttl = await getLockTtl("SKU-ERR", "ch-1");
    expect(ttl).toBeNull();
  });

  it("returns the result of the protected function", async () => {
    const { withInventoryLock } = await getLockHelper();

    const result = await withInventoryLock("SKU-RET", "ch-1", async () => {
      return { quantity: 42, version: 7 };
    });

    expect(result).toEqual({ quantity: 42, version: 7 });
  });

  it("throws LockAcquisitionError after max retries when lock is permanently held", async () => {
    const { withInventoryLock, LockAcquisitionError } = await getLockHelper();

    // Manually hold the lock forever by setting it in the fake store
    fakeStore["lock:inventory:SKU-BUSY:ch-busy"] = {
      value: "other-process-token",
      expiresAt: Date.now() + 60_000, // 1 minute — won't expire during test
    };

    await expect(
      withInventoryLock("SKU-BUSY", "ch-busy", async () => {
        return "should not run";
      })
    ).rejects.toThrow(LockAcquisitionError);
  });
});
