/**
 * tests/scoring.test.ts
 *
 * Unit tests for lib/scoring.ts
 *
 * Tests every rule evaluator in isolation, then the composite scorer.
 * All inputs are deterministic (fixed nowMs) so results are reproducible.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateLargeDelta,
  evaluateNegativeQuantity,
  evaluateHighEventFrequency,
  evaluateRepeatedFailures,
  computeAnomalyScore,
  SCORING_CONSTANTS,
} from "../lib/scoring";
import type { SyncEvent } from "../lib/supabase";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  overrides: Partial<SyncEvent> = {}
): Pick<SyncEvent, "product_id" | "channel_id" | "status" | "created_at"> {
  return {
    product_id: "product-abc",
    channel_id: "channel-xyz",
    status: "success",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeEventsInWindow(
  count: number,
  windowMs: number,
  nowMs: number,
  overrides: Partial<SyncEvent> = {}
): Pick<SyncEvent, "product_id" | "channel_id" | "status" | "created_at">[] {
  return Array.from({ length: count }, (_, i) => ({
    product_id: "product-abc",
    channel_id: "channel-xyz",
    status: "success" as const,
    created_at: new Date(nowMs - windowMs / 2 + i * 100).toISOString(), // spread within window
    ...overrides,
  }));
}

// ---------------------------------------------------------------------------
// Rule 1: Large Delta
// ---------------------------------------------------------------------------

describe("evaluateLargeDelta", () => {
  it("does NOT trigger when delta is within threshold", () => {
    // 30% threshold: delta of 10 on base 100 = 10% → no trigger
    const result = evaluateLargeDelta(10, 100);
    expect(result.triggered).toBe(false);
    expect(result.score_contribution).toBe(0);
  });

  it("triggers when delta exceeds threshold", () => {
    // 90% threshold breach: delta 90 on base 100
    const result = evaluateLargeDelta(90, 100);
    expect(result.triggered).toBe(true);
    expect(result.score_contribution).toBeGreaterThan(0);
    expect(result.score_contribution).toBeLessThanOrEqual(
      SCORING_CONSTANTS.MAX_SCORE_LARGE_DELTA
    );
  });

  it("triggers with negative delta (large sale)", () => {
    // -50 on base 100 = 50% → above 30% threshold
    const result = evaluateLargeDelta(-50, 100);
    expect(result.triggered).toBe(true);
    expect(result.score_contribution).toBeGreaterThan(0);
  });

  it("returns partial score when base_quantity is zero", () => {
    const result = evaluateLargeDelta(5, 0);
    expect(result.triggered).toBe(true);
    expect(result.score_contribution).toBeGreaterThan(0);
    expect(result.detail).toContain("base_quantity is 0");
  });

  it("caps score contribution at MAX_SCORE_LARGE_DELTA", () => {
    // 1000% delta: way above threshold — should cap at max
    const result = evaluateLargeDelta(1000, 100);
    expect(result.score_contribution).toBeLessThanOrEqual(
      SCORING_CONSTANTS.MAX_SCORE_LARGE_DELTA
    );
  });

  it("score increases proportionally with delta magnitude", () => {
    const small = evaluateLargeDelta(40, 100);  // 40%
    const large = evaluateLargeDelta(90, 100);  // 90%
    // Both above threshold; larger delta should have higher or equal score
    expect(large.score_contribution).toBeGreaterThanOrEqual(
      small.score_contribution
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 2: Negative Resulting Quantity
// ---------------------------------------------------------------------------

describe("evaluateNegativeQuantity", () => {
  it("does NOT trigger for zero quantity", () => {
    const result = evaluateNegativeQuantity(0);
    expect(result.triggered).toBe(false);
    expect(result.score_contribution).toBe(0);
  });

  it("does NOT trigger for positive quantity", () => {
    const result = evaluateNegativeQuantity(50);
    expect(result.triggered).toBe(false);
  });

  it("triggers for -1 (oversell by 1 unit)", () => {
    const result = evaluateNegativeQuantity(-1);
    expect(result.triggered).toBe(true);
    expect(result.score_contribution).toBeGreaterThanOrEqual(
      Math.round(SCORING_CONSTANTS.MAX_SCORE_NEGATIVE_QUANTITY * 0.5)
    );
  });

  it("triggers with full score for deeply negative quantity", () => {
    const result = evaluateNegativeQuantity(-100);
    expect(result.triggered).toBe(true);
    expect(result.score_contribution).toBe(
      SCORING_CONSTANTS.MAX_SCORE_NEGATIVE_QUANTITY
    );
  });

  it("score increases with magnitude of negative quantity", () => {
    const shallow = evaluateNegativeQuantity(-1);
    const deep    = evaluateNegativeQuantity(-50);
    expect(deep.score_contribution).toBeGreaterThanOrEqual(
      shallow.score_contribution
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 3: High Event Frequency
// ---------------------------------------------------------------------------

describe("evaluateHighEventFrequency", () => {
  const nowMs = 1_700_000_000_000;
  const WINDOW = SCORING_CONSTANTS.ROLLING_WINDOW_MS;

  it("does NOT trigger when event count is at threshold", () => {
    const events = makeEventsInWindow(
      SCORING_CONSTANTS.EVENT_COUNT_THRESHOLD,
      WINDOW,
      nowMs
    );
    const result = evaluateHighEventFrequency(events, "product-abc", nowMs);
    expect(result.triggered).toBe(false);
    expect(result.score_contribution).toBe(0);
  });

  it("triggers when event count exceeds threshold by 1", () => {
    const events = makeEventsInWindow(
      SCORING_CONSTANTS.EVENT_COUNT_THRESHOLD + 1,
      WINDOW,
      nowMs
    );
    const result = evaluateHighEventFrequency(events, "product-abc", nowMs);
    expect(result.triggered).toBe(true);
    expect(result.score_contribution).toBeGreaterThan(0);
  });

  it("ignores events outside the rolling window", () => {
    const old = Array.from({ length: 20 }, (_, i) => ({
      product_id: "product-abc",
      channel_id: "channel-xyz",
      status: "success" as const,
      // 2 windows ago → should be ignored
      created_at: new Date(nowMs - WINDOW * 2 - i * 1000).toISOString(),
    }));
    const result = evaluateHighEventFrequency(old, "product-abc", nowMs);
    expect(result.triggered).toBe(false);
  });

  it("only counts events for the correct product_id", () => {
    const events = makeEventsInWindow(SCORING_CONSTANTS.EVENT_COUNT_THRESHOLD + 3, WINDOW, nowMs, {
      product_id: "other-product",
    });
    const result = evaluateHighEventFrequency(events, "product-abc", nowMs);
    expect(result.triggered).toBe(false);
  });

  it("caps contribution at MAX_SCORE_HIGH_FREQUENCY", () => {
    const events = makeEventsInWindow(1000, WINDOW, nowMs);
    const result = evaluateHighEventFrequency(events, "product-abc", nowMs);
    expect(result.score_contribution).toBeLessThanOrEqual(
      SCORING_CONSTANTS.MAX_SCORE_HIGH_FREQUENCY
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 4: Repeated Failures
// ---------------------------------------------------------------------------

describe("evaluateRepeatedFailures", () => {
  const nowMs = 1_700_000_000_000;
  const WINDOW = SCORING_CONSTANTS.ROLLING_WINDOW_MS;

  function makeFailureEvents(
    count: number,
    status: "failure" | "success" = "failure"
  ) {
    return Array.from({ length: count }, (_, i) => ({
      product_id: "product-abc",
      channel_id: "channel-xyz",
      status,
      created_at: new Date(nowMs - i * 1000).toISOString(),
    }));
  }

  it("does NOT trigger below failure threshold", () => {
    const events = makeFailureEvents(SCORING_CONSTANTS.FAILURE_COUNT_THRESHOLD - 1);
    const result = evaluateRepeatedFailures(events, "channel-xyz", nowMs);
    expect(result.triggered).toBe(false);
    expect(result.score_contribution).toBe(0);
  });

  it("triggers at exactly the failure threshold", () => {
    const events = makeFailureEvents(SCORING_CONSTANTS.FAILURE_COUNT_THRESHOLD);
    const result = evaluateRepeatedFailures(events, "channel-xyz", nowMs);
    expect(result.triggered).toBe(true);
    expect(result.score_contribution).toBeGreaterThan(0);
  });

  it("does NOT count failures for a different channel", () => {
    const events = makeFailureEvents(10).map((e) => ({
      ...e,
      channel_id: "other-channel",
    }));
    const result = evaluateRepeatedFailures(events, "channel-xyz", nowMs);
    expect(result.triggered).toBe(false);
  });

  it("stops counting on first success in sequence", () => {
    // 2 failures, then a success, then 10 more failures
    // Consecutive count from top = 2 (below threshold of 3)
    const events = [
      ...makeFailureEvents(2, "failure"),
      makeFailureEvents(1, "success")[0],
      ...makeFailureEvents(10, "failure").map((e) => ({
        ...e,
        created_at: new Date(
          new Date(e.created_at).getTime() - 3000
        ).toISOString(),
      })),
    ];
    const result = evaluateRepeatedFailures(events, "channel-xyz", nowMs);
    expect(result.triggered).toBe(false);
  });

  it("caps contribution at MAX_SCORE_REPEATED_FAILURES", () => {
    const events = makeFailureEvents(100);
    const result = evaluateRepeatedFailures(events, "channel-xyz", nowMs);
    expect(result.score_contribution).toBeLessThanOrEqual(
      SCORING_CONSTANTS.MAX_SCORE_REPEATED_FAILURES
    );
  });
});

// ---------------------------------------------------------------------------
// Composite scorer: computeAnomalyScore
// ---------------------------------------------------------------------------

describe("computeAnomalyScore", () => {
  const nowMs = 1_700_000_000_000;
  const WINDOW = SCORING_CONSTANTS.ROLLING_WINDOW_MS;

  it("returns 0 for a completely normal event", () => {
    const result = computeAnomalyScore({
      delta: 5,
      resultingQuantity: 95,
      baseQuantity: 200,
      recentEvents: [makeEvent()],
      channelId: "channel-xyz",
      nowMs,
    });
    expect(result.score).toBe(0);
  });

  it("returns a high score when all rules trigger", () => {
    const failureEvents = Array.from(
      { length: SCORING_CONSTANTS.FAILURE_COUNT_THRESHOLD + 5 },
      (_, i) => ({
        product_id: "product-abc",
        channel_id: "channel-xyz",
        status: "failure" as const,
        created_at: new Date(nowMs - i * 500).toISOString(),
      })
    );

    const result = computeAnomalyScore({
      delta: -500,             // Large delta
      resultingQuantity: -10,  // Negative quantity
      baseQuantity: 100,
      recentEvents: failureEvents,
      channelId: "channel-xyz",
      nowMs,
    });

    expect(result.score).toBeGreaterThan(60);
    expect(result.rules.large_delta.triggered).toBe(true);
    expect(result.rules.negative_quantity.triggered).toBe(true);
    expect(result.rules.repeated_failures.triggered).toBe(true);
  });

  it("score is clamped between 0 and 100", () => {
    const result = computeAnomalyScore({
      delta: -99999,
      resultingQuantity: -99999,
      baseQuantity: 1,
      recentEvents: Array.from({ length: 100 }, (_, i) => ({
        product_id: "product-abc",
        channel_id: "channel-xyz",
        status: "failure" as const,
        created_at: new Date(nowMs - i * 100).toISOString(),
      })),
      channelId: "channel-xyz",
      nowMs,
    });

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("provides a rule breakdown for every triggered rule", () => {
    const result = computeAnomalyScore({
      delta: -60,
      resultingQuantity: -5,
      baseQuantity: 100,
      recentEvents: [makeEvent()],
      channelId: "channel-xyz",
      nowMs,
    });

    expect(result.rules).toHaveProperty("large_delta");
    expect(result.rules).toHaveProperty("negative_quantity");
    expect(result.rules).toHaveProperty("high_event_frequency");
    expect(result.rules).toHaveProperty("repeated_failures");
    expect(result.rules.large_delta.triggered).toBe(true);
    expect(result.rules.negative_quantity.triggered).toBe(true);
  });
});
