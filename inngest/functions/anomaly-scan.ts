/**
 * inngest/functions/anomaly-scan.ts
 *
 * Inngest function: anomaly scanner (cron + on-demand)
 *
 * Runs on two triggers:
 *   1. Cron: every 5 minutes (scans all recent sync events)
 *   2. Event: "anomaly/check.trigger" (fired after each successful sync for fast-path)
 *
 * For each (product, channel) pair with events above the scoring threshold:
 *   1. Computes deterministic severity score via scoring.ts
 *   2. If score >= LLM trigger threshold, calls the LLM for a plain-English explanation
 *   3. Writes an anomaly_snapshots document to MongoDB
 *   4. Broadcasts an anomaly:detected Pusher event to the dashboard
 */

import { inngest } from "@/inngest/client";
import {
  getRecentSyncEvents,
  getSupabaseClient,
  getProductBySku,
  type SyncEvent,
} from "@/lib/supabase";
import { saveAnomalySnapshot } from "@/lib/mongo";
import { broadcastAnomalyAlert } from "@/lib/pusher";
import {
  computeAnomalyScore,
  getLlmTriggerThreshold,
  type ScoringInput,
} from "@/lib/scoring";
import { generateAnomalyExplanation } from "@/lib/ai/fallback";

// ---------------------------------------------------------------------------
// Shared scan logic (used by both cron and event-triggered runs)
// ---------------------------------------------------------------------------

async function scanAndProcess(
  events: SyncEvent[],
  targetProductId?: string,
  targetChannelId?: string
): Promise<{ processed: number; anomalies: number }> {
  const db = getSupabaseClient();

  // Group events by (product_id, channel_id)
  const grouped = new Map<string, SyncEvent[]>();
  for (const event of events) {
    // If we have a specific target, only process that
    if (targetProductId && event.product_id !== targetProductId) continue;
    if (targetChannelId && event.channel_id !== targetChannelId) continue;

    const key = `${event.product_id}:${event.channel_id}`;
    const existing = grouped.get(key) ?? [];
    existing.push(event);
    grouped.set(key, existing);
  }

  let processed = 0;
  let anomaliesDetected = 0;

  for (const [key, groupEvents] of grouped.entries()) {
    const [productId, channelId] = key.split(":");

    // Get the most recent event in this group (the one that triggered)
    const latestEvent = groupEvents.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0];

    // Fetch product details for base_quantity
    const { data: product, error: pErr } = await db
      .from("products")
      .select("id, sku, name, base_quantity")
      .eq("id", productId)
      .single();

    if (pErr || !product) continue;

    // Fetch channel details
    const { data: channel, error: cErr } = await db
      .from("channels")
      .select("id, name")
      .eq("id", channelId)
      .single();

    if (cErr || !channel) continue;

    // Build scoring input
    const scoringInput: ScoringInput = {
      delta:             latestEvent.delta,
      resultingQuantity: latestEvent.resulting_quantity,
      baseQuantity:      product.base_quantity,
      recentEvents:      groupEvents,
      channelId,
      nowMs:             Date.now(),
    };

    const scoringResult = computeAnomalyScore(scoringInput);
    processed++;

    const threshold = getLlmTriggerThreshold();
    if (scoringResult.score < threshold) continue;

    // --- Above threshold: generate LLM explanation ---
    let explanation = `Anomaly detected with severity score ${scoringResult.score}/100. ` +
      `Manual review recommended.`;
    let llmModel = "none (below threshold or error)";

    try {
      const llmResult = await generateAnomalyExplanation({
        sku: product.sku,
        channelName: channel.name,
        score: scoringResult.score,
        scoringResult,
        baseQuantity: product.base_quantity,
        delta: latestEvent.delta,
        resultingQuantity: latestEvent.resulting_quantity,
      });
      explanation = llmResult.text;
      llmModel    = llmResult.modelUsed;
    } catch (err) {
      console.error("[anomaly-scan] LLM explanation failed:", err);
      // Continue with deterministic fallback explanation — don't fail the job
    }

    // Fetch channel_inventory snapshot
    const { data: inventorySnapshot } = await db
      .from("channel_inventory")
      .select("*")
      .eq("product_id", productId)
      .eq("channel_id", channelId)
      .single();

    // Write MongoDB snapshot
    const snapshotId = await saveAnomalySnapshot({
      product_id: productId,
      channel_id: channelId,
      sku:          product.sku,
      channel_name: channel.name,
      score:         scoringResult.score,
      rule_breakdown: scoringResult.rules as unknown as import("@/lib/mongo").RuleBreakdown,
      explanation,
      llm_model: llmModel,
      full_state_snapshot: {
        channel_inventory: inventorySnapshot ?? {},
        recent_sync_events: groupEvents.slice(0, 20) as unknown as Record<string, unknown>[],
        product,
      },
      created_at: new Date(),
    });

    // Broadcast Pusher alert
    await broadcastAnomalyAlert({
      snapshotId,
      sku:          product.sku,
      productName:  product.name,
      channelName:  channel.name,
      score:         scoringResult.score,
      explanation,
      llmModel,
      ruleBreakdown: scoringResult.rules,
      detectedAt:    new Date().toISOString(),
    });

    anomaliesDetected++;
  }

  return { processed, anomalies: anomaliesDetected };
}

// ---------------------------------------------------------------------------
// Cron: run every 5 minutes, scans all recent events
// ---------------------------------------------------------------------------

export const anomalyScanCron = inngest.createFunction(
  {
    id: "anomaly-scan-cron",
    name: "Anomaly Scanner (Scheduled)",
    triggers: [{ cron: "*/5 * * * *" }],
    retries: 3,
  },
  async ({ step }: any) => {
    const events = await step.run("fetch-recent-events", async () => {
      return getRecentSyncEvents(15, 500);
    });

    const result = await step.run("scan-and-score", async () => {
      return scanAndProcess(events);
    });

    return {
      trigger: "cron",
      eventCount: events.length,
      ...result,
    };
  }
);

// ---------------------------------------------------------------------------
// On-demand: triggered by sync-channel-update after a successful sync
// This provides fast-path detection without waiting for the next cron run
// ---------------------------------------------------------------------------

export const anomalyScanOnDemand = inngest.createFunction(
  {
    id: "anomaly-scan-on-demand",
    name: "Anomaly Scanner (On-Demand)",
    triggers: [{ event: "anomaly/check.trigger" }],
    retries: 2,
    debounce: {
      period: "30s",
      key: "event.data.productId",
    },
  },
  async ({ event, step }: any) => {
    const { productId, channelId, sku } = event.data;

    const events = await step.run("fetch-recent-events", async () => {
      return getRecentSyncEvents(5, 100);
    });

    const result = await step.run("scan-and-score", async () => {
      return scanAndProcess(events, productId, channelId);
    });

    return {
      trigger: "on-demand",
      sku,
      ...result,
    };
  }
);
