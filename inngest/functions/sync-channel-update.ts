/**
 * inngest/functions/sync-channel-update.ts
 *
 * Inngest function: "sync/channel.update"
 *
 * Triggered by inbound webhook payloads, this function:
 *   1. Acquires a distributed Redis lock for (SKU, channelId)
 *   2. Reads the current channel_inventory with its version
 *   3. Applies the delta with optimistic concurrency (OCC)
 *   4. Retries if OCC check fails (version conflict = another process won)
 *   5. Writes a sync_event to the audit log
 *   6. Saves the raw payload to MongoDB
 *   7. Broadcasts a Pusher event to live dashboard clients
 *
 * Inngest handles retries with exponential backoff for any transient failures
 * (DB timeouts, Pusher errors, etc.) — the function is idempotent by design.
 */

import { NonRetriableError } from "inngest";
import { inngest } from "@/inngest/client";
import { withInventoryLock, LockAcquisitionError } from "@/lib/redis";
import {
  getSupabaseClient,
  getProductBySku,
  getChannelInventory,
  updateChannelInventoryOCC,
  upsertChannelInventory,
  insertSyncEvent,
} from "@/lib/supabase";
import { saveRawPayload } from "@/lib/mongo";
import { broadcastInventoryUpdate } from "@/lib/pusher";

// Max OCC retry attempts before giving up on this specific sync event
const OCC_MAX_RETRIES = 5;
// Delay between OCC retries (ms)
const OCC_RETRY_DELAY_MS = 100;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export const syncChannelUpdate = inngest.createFunction(
  {
    id: "sync-channel-update",
    name: "Sync Channel Inventory Update",
    triggers: [{ event: "sync/channel.update" }],
    retries: 5,
    throttle: {
      limit: 100,
      period: "10s",
    },
  },
  async ({ event, step }: any) => {
    const { channel, channelId, sku, delta, rawPayload, webhookTimestamp } = event.data;

    // ── Step 1: Resolve product ─────────────────────────────────────────────
    const product = await step.run("resolve-product", async () => {
      const p = await getProductBySku(sku);
      if (!p) {
        throw new NonRetriableError(
          `Product with SKU "${sku}" not found. Cannot process sync event.`
        );
      }
      return p;
    });

    // ── Step 2: Save raw payload to MongoDB ─────────────────────────────────
    // Do this before acquiring the lock — MongoDB write is idempotent via _id
    const mongoDocId = await step.run("save-raw-payload", async () => {
      return saveRawPayload({
        channel,
        sku,
        raw: rawPayload,
        received_at: new Date(webhookTimestamp),
        inngest_event_id: event.id,
        processed: false,
      });
    });

    // ── Step 3: Acquire lock + apply delta ──────────────────────────────────
    const syncResult = await step.run("apply-inventory-delta", async () => {
      return withInventoryLock(sku, channelId, async () => {
        // Fetch current inventory row
        let inventory = await getChannelInventory(product.id, channelId);

        if (!inventory) {
          // First sync for this product/channel — initialize to base_quantity
          await upsertChannelInventory({
            product_id: product.id,
            channel_id: channelId,
            quantity: product.base_quantity,
            last_synced_at: new Date().toISOString(),
            version: 0,
          });
          inventory = {
            product_id: product.id,
            channel_id: channelId,
            quantity: product.base_quantity,
            last_synced_at: new Date().toISOString(),
            version: 0,
          };
        }

        const newQuantity = inventory.quantity + delta;

        // OCC retry loop
        let occSuccess = false;
        let currentVersion = inventory.version;
        let currentQuantity = inventory.quantity;

        for (let attempt = 0; attempt < OCC_MAX_RETRIES; attempt++) {
          const updated = await updateChannelInventoryOCC(
            product.id,
            channelId,
            newQuantity,
            currentVersion
          );

          if (updated) {
            occSuccess = true;
            break;
          }

          // Version conflict — re-read and retry
          const fresh = await getChannelInventory(product.id, channelId);
          if (!fresh) break;
          currentVersion = fresh.version;
          currentQuantity = fresh.quantity;

          if (attempt < OCC_MAX_RETRIES - 1) {
            await sleep(OCC_RETRY_DELAY_MS * (attempt + 1));
          }
        }

        if (!occSuccess) {
          throw new Error(
            `Optimistic concurrency conflict: failed to update inventory for SKU "${sku}" ` +
            `after ${OCC_MAX_RETRIES} OCC retries.`
          );
        }

        return {
          productId: product.id,
          previousQuantity: currentQuantity,
          newQuantity,
          version: currentVersion + 1,
        };
      }).catch((err) => {
        if (err instanceof LockAcquisitionError) {
          // Lock is held by another process — Inngest will retry
          throw new Error(`Lock unavailable for SKU "${sku}": ${err.message}`);
        }
        throw err;
      });
    });

    // ── Step 4: Write audit log ─────────────────────────────────────────────
    const syncEvent = await step.run("write-sync-event", async () => {
      return insertSyncEvent({
        product_id: product.id,
        channel_id: channelId,
        delta,
        resulting_quantity: syncResult.newQuantity,
        status: "success",
        error: null,
      });
    });

    // ── Step 5: Mark MongoDB payload as processed ───────────────────────────
    await step.run("mark-payload-processed", async () => {
      const { getMongoDB } = await import("@/lib/mongo");
      const { ObjectId } = await import("mongodb");
      const db = await getMongoDB();
      await db.collection("raw_channel_payloads").updateOne(
        { _id: new ObjectId(mongoDocId) },
        { $set: { processed: true } }
      );
    });

    // ── Step 6: Broadcast real-time update ─────────────────────────────────
    await step.run("broadcast-pusher-event", async () => {
      await broadcastInventoryUpdate({
        sku,
        productName: product.name,
        channelName: channel,
        channelId,
        productId: product.id,
        quantity: syncResult.newQuantity,
        delta,
        version: syncResult.version,
        syncedAt: new Date().toISOString(),
      });
    });

    // ── Step 7: Trigger anomaly check for this SKU ──────────────────────────
    await step.sendEvent("trigger-anomaly-check", {
      name: "anomaly/check.trigger",
      data: {
        productId: product.id,
        channelId,
        sku,
      },
    });

    return {
      success: true,
      sku,
      channel,
      delta,
      previousQuantity: syncResult.previousQuantity,
      newQuantity:      syncResult.newQuantity,
      version:          syncResult.version,
      syncEventId:      syncEvent.id,
      mongoDocId,
    };
  }
);
