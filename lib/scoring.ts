/**
 * lib/scoring.ts
 *
 * Deterministic anomaly severity scoring engine.
 *
 * Computes a 0–100 score for a given (product, channel) snapshot by
 * evaluating four independent rules and combining their contributions.
 * All logic is pure TypeScript — no LLM involved.
 *
 * Rules and weight constants are clearly named and can be adjusted via
 * environment variables (ANOMALY_*) without code changes.
 *
 * ┌──────────────────────────────────────────┬──────────────────┐
 * │ Rule                                     │ Max contribution │
 * ├──────────────────────────────────────────┼──────────────────┤
 * │ Large delta (% of base_quantity)         │ 35               │
 * │ Negative resulting_quantity              │ 30               │
 * │ High event frequency (count in window)   │ 20               │
 * │ Repeated sync failures for channel       │ 15               │
 * ├──────────────────────────────────────────┼──────────────────┤
 * │ Total                                    │ 100              │
 * └──────────────────────────────────────────┴──────────────────┘
 */

import type { SyncEvent } from "./supabase";

// ---------------------------------------------------------------------------
// Scoring constants (public so unit tests can reference them directly)
// ---------------------------------------------------------------------------

export const SCORING_CONSTANTS = {
  /**
   * If |delta| / base_quantity > this fraction, the large-delta rule fires.
   * Default: 0.30 (30%). Configurable via ANOMALY_DELTA_PCT_THRESHOLD env var.
   */
  DELTA_PCT_THRESHOLD: (() => {
    const v = Number(process.env.ANOMALY_DELTA_PCT_THRESHOLD);
    return isNaN(v) ? 30 : v;
  })() / 100,

  /**
   * More than K sync events for the same SKU in the rolling window triggers
   * the high-frequency rule. Default: 5.
   */
  EVENT_COUNT_THRESHOLD: (() => {
    const v = Number(process.env.ANOMALY_EVENT_COUNT_THRESHOLD);
    return isNaN(v) ? 5 : v;
  })(),

  /**
   * Rolling window in seconds for event-frequency counting.
   * Default: 60 seconds.
   */
  ROLLING_WINDOW_MS: (() => {
    const v = Number(process.env.ANOMALY_ROLLING_WINDOW_SECONDS);
    return isNaN(v) ? 60 : v;
  })() * 1_000,

  /**
   * Number of consecutive/recent failure events that triggers the
   * repeated-failures rule. Default: 3.
   */
  FAILURE_COUNT_THRESHOLD: 3,

  // --- Maximum score contribution per rule ---
  MAX_SCORE_LARGE_DELTA:        35,
  MAX_SCORE_NEGATIVE_QUANTITY:  30,
  MAX_SCORE_HIGH_FREQUENCY:     20,
  MAX_SCORE_REPEATED_FAILURES:  15,
} as const;

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface ScoringInput {
  /** Signed delta from the inbound sync event (positive = restock, negative = sale). */
  delta: number;

  /** Resulting channel quantity after the delta was applied. */
  resultingQuantity: number;

  /** Product's canonical base_quantity from the products table. */
  baseQuantity: number;

  /**
   * All sync events for this product (across channels) within a recent lookback window.
   * Caller is responsible for pre-filtering to the relevant time range.
   */
  recentEvents: Pick<SyncEvent, "product_id" | "channel_id" | "status" | "created_at">[];

  /** The channel being evaluated (for isolating channel-specific failures). */
  channelId: string;

  /** Unix timestamp (ms) used as the "now" reference for rolling window calculations.
   *  Defaults to Date.now() if omitted. Inject for deterministic unit tests. */
  nowMs?: number;
}

export interface RuleResult {
  triggered: boolean;
  score_contribution: number;
  detail: string;
}

export interface ScoringResult {
  /** Final 0–100 clamped severity score. */
  score: number;

  /** Per-rule breakdown for transparency and logging. */
  rules: {
    large_delta: RuleResult;
    negative_quantity: RuleResult;
    high_event_frequency: RuleResult;
    repeated_failures: RuleResult;
  };
}

// ---------------------------------------------------------------------------
// Individual rule evaluators (pure functions — easy to unit test in isolation)
// ---------------------------------------------------------------------------

/**
 * Rule 1: Large Delta
 * Fires when the absolute delta exceeds N% of the product's base_quantity
 * within the event's timeframe.
 * Score scales linearly from 0 → MAX based on how many times N% the delta is.
 */
export function evaluateLargeDelta(
  delta: number,
  baseQuantity: number
): RuleResult {
  const { DELTA_PCT_THRESHOLD, MAX_SCORE_LARGE_DELTA } = SCORING_CONSTANTS;

  if (baseQuantity <= 0) {
    // Zero-base inventory is inherently anomalous — award partial score
    return {
      triggered: true,
      score_contribution: Math.floor(MAX_SCORE_LARGE_DELTA * 0.5),
      detail: `base_quantity is ${baseQuantity}; any delta is anomalous`,
    };
  }

  const ratio = Math.abs(delta) / baseQuantity;

  if (ratio <= DELTA_PCT_THRESHOLD) {
    return {
      triggered: false,
      score_contribution: 0,
      detail: `delta ratio ${(ratio * 100).toFixed(1)}% is within threshold (${DELTA_PCT_THRESHOLD * 100}%)`,
    };
  }

  // Score scales: at 1× threshold → min fraction, at 3× threshold → full score
  const excess = ratio / DELTA_PCT_THRESHOLD; // 1.0 at threshold, higher above
  const fraction = Math.min(1, (excess - 1) / 2); // 0–1 over 1×–3× range
  const contribution = Math.round(fraction * MAX_SCORE_LARGE_DELTA);

  return {
    triggered: true,
    score_contribution: contribution,
    detail: `delta ${delta} is ${(ratio * 100).toFixed(1)}% of base_quantity ${baseQuantity} (threshold ${DELTA_PCT_THRESHOLD * 100}%)`,
  };
}

/**
 * Rule 2: Negative Resulting Quantity
 * A channel reporting negative stock is always anomalous — it means more
 * units were sold than available. Awards full weight if triggered.
 */
export function evaluateNegativeQuantity(resultingQuantity: number): RuleResult {
  const { MAX_SCORE_NEGATIVE_QUANTITY } = SCORING_CONSTANTS;

  if (resultingQuantity >= 0) {
    return {
      triggered: false,
      score_contribution: 0,
      detail: `resulting_quantity ${resultingQuantity} is non-negative`,
    };
  }

  // Scale: -1 → small contribution, very negative → full score
  const severity = Math.min(1, Math.abs(resultingQuantity) / 10);
  const contribution = Math.max(
    Math.round(severity * MAX_SCORE_NEGATIVE_QUANTITY),
    Math.round(MAX_SCORE_NEGATIVE_QUANTITY * 0.5) // minimum 50% if triggered
  );

  return {
    triggered: true,
    score_contribution: contribution,
    detail: `resulting_quantity is ${resultingQuantity} (negative stock oversell detected)`,
  };
}

/**
 * Rule 3: High Event Frequency
 * Fires when more than K sync events for the same product occur within
 * the rolling window. Could indicate a runaway integration or DDoS.
 */
export function evaluateHighEventFrequency(
  recentEvents: Pick<SyncEvent, "product_id" | "created_at">[],
  productId: string,
  nowMs: number
): RuleResult {
  const { EVENT_COUNT_THRESHOLD, ROLLING_WINDOW_MS, MAX_SCORE_HIGH_FREQUENCY } =
    SCORING_CONSTANTS;

  const windowStart = nowMs - ROLLING_WINDOW_MS;
  const windowEvents = recentEvents.filter(
    (e) =>
      e.product_id === productId &&
      new Date(e.created_at).getTime() >= windowStart
  );

  const count = windowEvents.length;

  if (count <= EVENT_COUNT_THRESHOLD) {
    return {
      triggered: false,
      score_contribution: 0,
      detail: `${count} events in rolling window (threshold ${EVENT_COUNT_THRESHOLD})`,
    };
  }

  // Score scales with excess count
  const excess = count / EVENT_COUNT_THRESHOLD;
  const fraction = Math.min(1, (excess - 1) / (EVENT_COUNT_THRESHOLD - 1));
  const contribution = Math.round(fraction * MAX_SCORE_HIGH_FREQUENCY);

  return {
    triggered: true,
    score_contribution: contribution,
    detail: `${count} events in ${SCORING_CONSTANTS.ROLLING_WINDOW_MS / 1000}s window (threshold ${EVENT_COUNT_THRESHOLD})`,
  };
}

/**
 * Rule 4: Repeated Sync Failures
 * Fires when a channel has a run of consecutive failures in recent events.
 * Indicates an integration outage or broken channel config.
 */
export function evaluateRepeatedFailures(
  recentEvents: Pick<SyncEvent, "channel_id" | "status" | "created_at">[],
  channelId: string,
  nowMs: number
): RuleResult {
  const { FAILURE_COUNT_THRESHOLD, ROLLING_WINDOW_MS, MAX_SCORE_REPEATED_FAILURES } =
    SCORING_CONSTANTS;

  const windowStart = nowMs - ROLLING_WINDOW_MS;
  const channelEvents = recentEvents
    .filter(
      (e) =>
        e.channel_id === channelId &&
        new Date(e.created_at).getTime() >= windowStart
    )
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

  // Count consecutive failures from most recent event
  let consecutiveFailures = 0;
  for (const event of channelEvents) {
    if (event.status === "failure" || event.status === "retrying") {
      consecutiveFailures++;
    } else {
      break; // Stop counting on first non-failure
    }
  }

  if (consecutiveFailures < FAILURE_COUNT_THRESHOLD) {
    return {
      triggered: false,
      score_contribution: 0,
      detail: `${consecutiveFailures} consecutive failures (threshold ${FAILURE_COUNT_THRESHOLD})`,
    };
  }

  const fraction = Math.min(
    1,
    consecutiveFailures / (FAILURE_COUNT_THRESHOLD * 2)
  );
  const contribution = Math.max(
    Math.round(fraction * MAX_SCORE_REPEATED_FAILURES),
    Math.round(MAX_SCORE_REPEATED_FAILURES * 0.5) // minimum 50% if triggered
  );

  return {
    triggered: true,
    score_contribution: contribution,
    detail: `${consecutiveFailures} consecutive failures for channel ${channelId}`,
  };
}

// ---------------------------------------------------------------------------
// Top-level scoring function
// ---------------------------------------------------------------------------

/**
 * Computes the composite anomaly severity score (0–100) for a sync event.
 *
 * @param input  Snapshot of the sync context
 * @returns      ScoringResult with the final score and per-rule breakdown
 */
export function computeAnomalyScore(input: ScoringInput): ScoringResult {
  const nowMs = input.nowMs ?? Date.now();

  const largeDelta        = evaluateLargeDelta(input.delta, input.baseQuantity);
  const negativeQuantity  = evaluateNegativeQuantity(input.resultingQuantity);
  const highFrequency     = evaluateHighEventFrequency(
    input.recentEvents,
    input.recentEvents[0]?.product_id ?? "",
    nowMs
  );
  const repeatedFailures  = evaluateRepeatedFailures(
    input.recentEvents,
    input.channelId,
    nowMs
  );

  const raw =
    largeDelta.score_contribution +
    negativeQuantity.score_contribution +
    highFrequency.score_contribution +
    repeatedFailures.score_contribution;

  const score = Math.min(100, Math.max(0, raw));

  return {
    score,
    rules: {
      large_delta:        largeDelta,
      negative_quantity:  negativeQuantity,
      high_event_frequency: highFrequency,
      repeated_failures:  repeatedFailures,
    },
  };
}

/**
 * Returns the LLM trigger threshold from env (default 60).
 */
export function getLlmTriggerThreshold(): number {
  const v = Number(process.env.ANOMALY_LLM_TRIGGER_SCORE);
  return isNaN(v) ? 60 : v;
}
