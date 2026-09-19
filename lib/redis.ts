/**
 * lib/redis.ts
 *
 * Distributed inventory lock using Upstash Redis.
 *
 * Algorithm:
 *   ACQUIRE: SET lock:{sku}:{channelId} {token} NX PX {ttlMs}
 *            Returns OK → we hold the lock.
 *            Returns null → lock is held, retry with exponential backoff.
 *
 *   RELEASE: Lua compare-and-delete (atomic):
 *            If GET(key) == token → DEL(key) and return 1
 *            Else → return 0  (someone else's lock — do NOT delete it)
 *
 * The unique token per acquisition prevents one process from accidentally
 * releasing another process's lock (e.g. if our own lock expired and was
 * re-acquired by a second caller before we tried to release it).
 *
 * References:
 *   - Redis SETNX pattern: https://redis.io/docs/manual/patterns/distributed-locks/
 *   - Upstash Redis HTTP client: https://github.com/upstash/upstash-redis
 */

import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Redis client singleton
// ---------------------------------------------------------------------------

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (_redis) return _redis;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      "Missing Upstash Redis env vars: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN"
    );
  }

  _redis = new Redis({ url, token });
  return _redis;
}

// ---------------------------------------------------------------------------
// Lock configuration
// ---------------------------------------------------------------------------

/** Lock TTL in milliseconds. After this the lock auto-expires (prevents deadlocks). */
const LOCK_TTL_MS = 15_000; // 15 seconds — enough for a sync cycle

/** Max number of retry attempts before giving up. */
const MAX_RETRIES = 8;

/** Base delay for exponential backoff in milliseconds. */
const BASE_DELAY_MS = 50;

/** Maximum cap on retry delay (ms). */
const MAX_DELAY_MS = 2_000;

// ---------------------------------------------------------------------------
// Lua script for safe compare-and-delete
// This runs atomically on the Redis server, avoiding a TOCTOU race between
// GET and DEL.
// ---------------------------------------------------------------------------
const RELEASE_LUA = `
  local val = redis.call('GET', KEYS[1])
  if val == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  else
    return 0
  end
`;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function lockKey(sku: string, channelId: string): string {
  return `lock:inventory:${sku}:${channelId}`;
}

function jitteredDelay(attempt: number): number {
  // Full jitter: random(0, min(cap, base * 2^attempt))
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.random() * exp;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class LockAcquisitionError extends Error {
  constructor(sku: string, channelId: string, retries: number) {
    super(
      `Failed to acquire inventory lock for SKU "${sku}" / channel "${channelId}" after ${retries} retries.`
    );
    this.name = "LockAcquisitionError";
  }
}

/**
 * Acquires an exclusive distributed lock on (sku, channelId), runs `fn`,
 * then releases the lock — even if `fn` throws.
 *
 * Serializes concurrent inventory mutations on the same SKU+channel pair.
 *
 * @param sku       Product SKU (used to build the lock key)
 * @param channelId UUID of the channel performing the update
 * @param fn        Async function to execute while the lock is held
 * @returns         Whatever `fn` returns
 * @throws          LockAcquisitionError if the lock cannot be acquired after MAX_RETRIES
 */
export async function withInventoryLock<T>(
  sku: string,
  channelId: string,
  fn: () => Promise<T>
): Promise<T> {
  const redis = getRedis();
  const key = lockKey(sku, channelId);
  const token = randomUUID(); // Unique token for this acquisition

  // ── ACQUIRE ───────────────────────────────────────────────────────────────
  let acquired = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // SET key token NX PX ttlMs
    const result = await redis.set(key, token, { nx: true, px: LOCK_TTL_MS });
    if (result === "OK") {
      acquired = true;
      break;
    }

    if (attempt < MAX_RETRIES) {
      const delay = jitteredDelay(attempt);
      await sleep(delay);
    }
  }

  if (!acquired) {
    throw new LockAcquisitionError(sku, channelId, MAX_RETRIES);
  }

  // ── EXECUTE ───────────────────────────────────────────────────────────────
  let result: T;
  try {
    result = await fn();
  } finally {
    // ── RELEASE (always, even on error) ──────────────────────────────────
    // Lua compare-and-delete: only removes the key if our token still matches.
    // If the lock TTL expired and was re-acquired, this is a safe no-op.
    await redis
      .eval(RELEASE_LUA, [key], [token])
      .catch((err) => {
        // Log but don't rethrow — the lock will auto-expire anyway via TTL.
        console.error("[redis] Lock release failed (will auto-expire):", err);
      });
  }

  return result!;
}

// ---------------------------------------------------------------------------
// Diagnostics helpers (for tests and the simulate-concurrent script)
// ---------------------------------------------------------------------------

/**
 * Checks whether a lock is currently held for a given SKU+channel.
 * Returns the remaining TTL in ms, or null if no lock is held.
 */
export async function getLockTtl(
  sku: string,
  channelId: string
): Promise<number | null> {
  const redis = getRedis();
  const key = lockKey(sku, channelId);
  const ttl = await redis.pttl(key);
  return ttl > 0 ? ttl : null;
}

/**
 * Force-deletes a lock regardless of who holds it.
 * Use ONLY in test teardown or emergency recovery.
 */
export async function forceReleaseLock(
  sku: string,
  channelId: string
): Promise<void> {
  const redis = getRedis();
  await redis.del(lockKey(sku, channelId));
}

export { getRedis };
