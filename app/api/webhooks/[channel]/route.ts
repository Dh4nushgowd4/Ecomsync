/**
 * app/api/webhooks/[channel]/route.ts
 *
 * Inbound webhook handler for all sales channels.
 *
 * Validates the incoming payload, normalizes it into EcomSync's internal
 * format, and fires an Inngest "sync/channel.update" event which the
 * sync-channel-update function processes asynchronously.
 *
 * Each channel can have its own signature verification logic (e.g., Shopify
 * HMAC, Amazon SNS subscription confirmation) added in the validators map.
 *
 * URL pattern: POST /api/webhooks/shopify
 *              POST /api/webhooks/amazon
 *              POST /api/webhooks/ebay
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { inngest } from "@/inngest/client";
import { getSupabaseClient, getProductBySku, getChannelInventory, upsertChannelInventory, insertSyncEvent } from "@/lib/supabase";
import { broadcastInventoryUpdate, broadcastAnomalyAlert } from "@/lib/pusher";
import { computeAnomalyScore } from "@/lib/scoring";
import { generateAnomalyExplanation } from "@/lib/ai/fallback";
import { saveAnomalySnapshot } from "@/lib/mongo";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Inbound webhook payload schema (normalized internal format)
// Real-world: each channel sends different shapes; a transformer per channel
// maps to this common schema. For now, we accept this canonical shape.
// ---------------------------------------------------------------------------

const WebhookPayloadSchema = z.object({
  sku:   z.string().min(1, "SKU is required"),
  delta: z.number().int("delta must be an integer"),
  // Optional: channels may include additional fields we log to MongoDB
  metadata: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Channel name allowlist
// ---------------------------------------------------------------------------

const ALLOWED_CHANNELS = ["shopify", "amazon", "ebay", "walmart", "etsy"] as const;
type ChannelName = (typeof ALLOWED_CHANNELS)[number];

// ---------------------------------------------------------------------------
// Per-channel signature verification
// In production: verify HMAC signatures, OAuth tokens, etc.
// Currently returns true for all to allow easy local testing.
// ---------------------------------------------------------------------------

async function verifyChannelSignature(
  channel: ChannelName,
  req: NextRequest,
  rawBody: string
): Promise<boolean> {
  // Shopify: X-Shopify-Hmac-Sha256 header
  // Amazon: AWS SNS signature verification
  // eBay: X-EBAY-SIGNATURE header
  // For now: accept all (TODO: implement per-channel verification)
  const _ = { channel, req, rawBody }; // suppress unused warning
  return true;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ channel: string }> }
) {
  try {
    const { channel } = await params;

    // ── 1. Validate channel name ────────────────────────────────────────────
    if (!ALLOWED_CHANNELS.includes(channel as ChannelName)) {
      return NextResponse.json(
        { error: `Unknown channel: "${channel}". Valid channels: ${ALLOWED_CHANNELS.join(", ")}` },
        { status: 404 }
      );
    }

    const channelName = channel as ChannelName;

    // ── 2. Read raw body ────────────────────────────────────────────────────
    const rawBody = await req.text();
    let jsonBody: unknown;
    try {
      jsonBody = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    // ── 3. Verify signature ─────────────────────────────────────────────────
    const isValid = await verifyChannelSignature(channelName, req, rawBody);
    if (!isValid) {
      return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
    }

    // ── 4. Parse and validate payload ───────────────────────────────────────
    const parsed = WebhookPayloadSchema.safeParse(jsonBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid payload", details: parsed.error.flatten() },
        { status: 422 }
      );
    }

    const { sku, delta, metadata } = parsed.data;

    // ── 5. Resolve channel ID from database ─────────────────────────────────
    const db = getSupabaseClient();
    const { data: channelRow, error: chErr } = await db
      .from("channels")
      .select("id")
      .eq("name", channelName)
      .single();

    if (chErr || !channelRow) {
      return NextResponse.json(
        { error: `Channel "${channelName}" is not registered in the database. Run the seed script first.` },
        { status: 404 }
      );
    }

    // ── 6. Direct Sync & Pusher Broadcast (Instant Live Update) ────────────
    const webhookTimestamp = new Date().toISOString();
    let updatedQuantity = 0;
    let productName = sku;

    try {
      const product = await getProductBySku(sku);
      if (product) {
        productName = product.name;
        const currentInv = await getChannelInventory(product.id, channelRow.id);
        const prevQty = currentInv ? currentInv.quantity : product.base_quantity;
        const newQty = prevQty + delta;
        updatedQuantity = newQty;

        await upsertChannelInventory({
          product_id: product.id,
          channel_id: channelRow.id,
          quantity: newQty,
          last_synced_at: webhookTimestamp,
          version: (currentInv?.version ?? 0) + 1,
        });

        await insertSyncEvent({
          product_id: product.id,
          channel_id: channelRow.id,
          delta,
          resulting_quantity: newQty,
          status: "success",
          error: null,
        });

        // Broadcast to Pusher immediately for real-time dashboard update
        try {
          await broadcastInventoryUpdate({
            sku,
            productName: product.name,
            channelName,
            channelId: channelRow.id,
            productId: product.id,
            quantity: newQty,
            delta,
            version: (currentInv?.version ?? 0) + 1,
            syncedAt: webhookTimestamp,
          });

          // Evaluate anomaly score
          const scoreResult = computeAnomalyScore({
            delta,
            resultingQuantity: newQty,
            baseQuantity: product.base_quantity,
            recentEvents: [],
            channelId: channelRow.id,
          });

          if (scoreResult.score >= 60) {
            const explanationResult = await generateAnomalyExplanation({
              sku,
              channelName,
              delta,
              resultingQuantity: newQty,
              baseQuantity: product.base_quantity,
              score: scoreResult.score,
              scoringResult: scoreResult,
            });

            const snapshotId = await saveAnomalySnapshot({
              product_id: product.id,
              channel_id: channelRow.id,
              sku,
              channel_name: channelName,
              score: scoreResult.score,
              rule_breakdown: scoreResult.rules,
              explanation: explanationResult.text,
              llm_model: explanationResult.modelUsed,
              full_state_snapshot: {
                channel_inventory: { quantity: newQty, sku },
                recent_sync_events: [],
                product: { id: product.id, name: product.name, base_quantity: product.base_quantity },
              },
              created_at: new Date(),
            });

            await broadcastAnomalyAlert({
              snapshotId,
              sku,
              productName: product.name,
              channelName,
              score: scoreResult.score,
              explanation: explanationResult.text,
              llmModel: explanationResult.modelUsed,
              ruleBreakdown: scoreResult.rules,
              detectedAt: webhookTimestamp,
            });
          }
        } catch (pushErr) {
          console.warn("[webhook] Broadcast or anomaly evaluation warning:", pushErr);
        }
      }
    } catch (dbErr) {
      console.error("[webhook] Direct DB update error:", dbErr);
    }

    // ── 7. Queue Inngest Event (for asynchronous processing / locks) ────────
    let inngestQueued = true;
    let inngestWarning: string | undefined;

    try {
      await inngest.send({
        name: "sync/channel.update",
        data: {
          channel: channelName,
          channelId: channelRow.id,
          sku,
          delta,
          rawPayload: { ...(typeof jsonBody === "object" ? jsonBody as Record<string, unknown> : {}), metadata },
          webhookTimestamp,
        },
      });
    } catch (inngestErr) {
      inngestQueued = false;
      inngestWarning = `Inngest event not queued: ${String(inngestErr)}`;
      console.warn("[webhook] Inngest send warning:", inngestErr);
    }

    return NextResponse.json(
      {
        accepted: true,
        sku,
        channel: channelName,
        delta,
        newQuantity: updatedQuantity,
        queuedAt: webhookTimestamp,
        inngestQueued,
        ...(inngestWarning ? { warning: inngestWarning } : {}),
      },
      { status: 202 }
    );
  } catch (err) {
    console.error("[webhook] Unhandled error:", err);
    return NextResponse.json(
      { error: "Internal server error", details: String(err) },
      { status: 500 }
    );
  }
}
