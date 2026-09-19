/**
 * lib/ai/tools.ts
 *
 * Vercel AI SDK tool definitions for the inventory chat agent.
 * Each tool is backed by a real database query — no mocked data.
 *
 * Tools:
 *   getInventoryForSku    — fetch channel quantities for a product SKU
 *   getRecentAnomalies    — fetch recent anomaly snapshots from MongoDB
 *   getChannelHealth      — fetch recent sync success/failure stats per channel
 */

import { tool } from "ai";
import { z } from "zod";
import {
  getSupabaseClient,
  getProductBySku,
  type SyncEvent,
} from "@/lib/supabase";
import { getAnomaliesAboveThreshold, type AnomalySnapshot } from "@/lib/mongo";

// ---------------------------------------------------------------------------
// Tool: getInventoryForSku
// ---------------------------------------------------------------------------

export const getInventoryForSkuTool = tool({
  description:
    "Retrieves the current inventory quantity for a product SKU across all active channels. " +
    "Use this when the user asks about stock levels, inventory counts, or how many units " +
    "are available on Shopify, Amazon, eBay, etc.",
  parameters: z.object({
    sku: z.string().describe("The product SKU to look up (e.g. 'SKU-001')"),
  }),
  execute: async ({ sku }: { sku: string }) => {
    const db = getSupabaseClient();

    // Fetch product first to validate SKU exists
    const product = await getProductBySku(sku);
    if (!product) {
      return { error: `No product found with SKU "${sku}"` };
    }

    // Fetch all channel_inventory rows for this product, joined with channel name
    const { data, error } = await db
      .from("channel_inventory")
      .select(`
        quantity,
        last_synced_at,
        version,
        channels (id, name)
      `)
      .eq("product_id", product.id);

    if (error) throw error;

    const channels = (data ?? []).map((row: {
      quantity: number;
      last_synced_at: string;
      version: number;
      channels: { id: string; name: string } | { id: string; name: string }[];
    }) => {
      const ch = Array.isArray(row.channels) ? row.channels[0] : row.channels;
      return {
        channel: ch?.name ?? "unknown",
        channelId: ch?.id ?? "",
        quantity: row.quantity,
        lastSyncedAt: row.last_synced_at,
        version: row.version,
      };
    });

    return {
      sku: product.sku,
      productName: product.name,
      baseQuantity: product.base_quantity,
      channels,
      totalChannelQuantity: channels.reduce((sum, c) => sum + c.quantity, 0),
    };
  },
});

// ---------------------------------------------------------------------------
// Tool: getRecentAnomalies
// ---------------------------------------------------------------------------

export const getRecentAnomaliesTool = tool({
  description:
    "Retrieves recent anomaly snapshots from the anomaly log. " +
    "Use this when the user asks about inventory anomalies, unusual stock movements, " +
    "alerts, or anything suspicious detected by the anomaly scanner.",
  parameters: z.object({
    minScore: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .default(0)
      .describe("Minimum anomaly severity score to filter by (0–100). Default: 0 (all anomalies)."),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .default(10)
      .describe("Maximum number of anomaly records to return. Default: 10."),
  }),
  execute: async ({ minScore, limit }: { minScore?: number; limit?: number }) => {
    const anomalies: AnomalySnapshot[] = await getAnomaliesAboveThreshold(
      minScore ?? 0,
      limit ?? 10
    );

    if (anomalies.length === 0) {
      return { message: "No anomalies found matching the criteria.", anomalies: [] };
    }

    return {
      total: anomalies.length,
      anomalies: anomalies.map((a) => ({
        id: a._id?.toHexString() ?? "",
        sku: a.sku,
        channelName: a.channel_name,
        score: a.score,
        explanation: a.explanation,
        llmModel: a.llm_model,
        ruleBreakdown: a.rule_breakdown,
        detectedAt: a.created_at.toISOString(),
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Tool: getChannelHealth
// ---------------------------------------------------------------------------

export const getChannelHealthTool = tool({
  description:
    "Returns a health summary for a specific sales channel, including recent " +
    "sync success rate, failure count, and last successful sync time. " +
    "Use this when the user asks about channel status, integration health, " +
    "or whether Shopify/Amazon/eBay syncing is working correctly.",
  parameters: z.object({
    channelName: z
      .enum(["shopify", "amazon", "ebay", "walmart", "etsy"])
      .describe("Name of the sales channel to check"),
    lookbackMinutes: z
      .number()
      .min(1)
      .max(1440)
      .optional()
      .default(60)
      .describe("How many minutes back to analyse sync events. Default: 60"),
  }),
  execute: async ({ channelName, lookbackMinutes }: { channelName: any; lookbackMinutes?: number }) => {
    const db = getSupabaseClient();

    // Resolve channel name to ID
    const { data: channel, error: chErr } = await db
      .from("channels")
      .select("id, name")
      .eq("name", channelName)
      .single();

    if (chErr || !channel) {
      return { error: `Channel "${channelName}" not found in the database.` };
    }

    const since = new Date(
      Date.now() - (lookbackMinutes ?? 60) * 60_000
    ).toISOString();

    const { data: events, error: evErr } = await db
      .from("sync_events")
      .select("status, created_at, delta, resulting_quantity")
      .eq("channel_id", channel.id)
      .gte("created_at", since)
      .order("created_at", { ascending: false });

    if (evErr) throw evErr;

    const allEvents = (events ?? []) as Pick<
      SyncEvent,
      "status" | "created_at" | "delta" | "resulting_quantity"
    >[];
    const total     = allEvents.length;
    const successes = allEvents.filter((e) => e.status === "success").length;
    const failures  = allEvents.filter((e) => e.status === "failure").length;
    const retrying  = allEvents.filter((e) => e.status === "retrying").length;
    const lastSuccess = allEvents.find((e) => e.status === "success");

    return {
      channelName,
      channelId: channel.id,
      lookbackMinutes,
      totalEvents: total,
      successCount: successes,
      failureCount: failures,
      retryingCount: retrying,
      successRate: total > 0 ? ((successes / total) * 100).toFixed(1) + "%" : "N/A",
      lastSuccessfulSync: lastSuccess?.created_at ?? null,
      status:
        total === 0
          ? "no_data"
          : failures / Math.max(total, 1) > 0.5
          ? "degraded"
          : failures > 0
          ? "partial"
          : "healthy",
    };
  },
});

// ---------------------------------------------------------------------------
// Combined tools object for use in streamText / generateText
// ---------------------------------------------------------------------------

export const inventoryTools = {
  getInventoryForSku: getInventoryForSkuTool,
  getRecentAnomalies: getRecentAnomaliesTool,
  getChannelHealth:   getChannelHealthTool,
};
