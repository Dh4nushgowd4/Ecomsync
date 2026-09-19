/**
 * inngest/client.ts
 *
 * Inngest client singleton for EcomSync.
 * Imported by both the Inngest route handler and all function definitions.
 */

import { Inngest } from "inngest";

// ---------------------------------------------------------------------------
// Typed event schemas for compile-time safety
// ---------------------------------------------------------------------------

export type EcomSyncEvents = {
  /**
   * Fired by the inbound webhook route handler when a channel sends an
   * inventory update. Processed by sync-channel-update.ts.
   */
  "sync/channel.update": {
    data: {
      channel: string;        // "shopify" | "amazon" | "ebay"
      channelId: string;      // UUID of the channel row
      sku: string;            // Product SKU
      delta: number;          // Signed quantity change
      rawPayload: Record<string, unknown>; // Verbatim webhook body
      webhookTimestamp: string;            // ISO 8601
    };
  };

  /**
   * Internal event fired by sync-channel-update on success to trigger
   * an immediate (non-cron) anomaly check for the affected SKU.
   * Optional — the cron still runs regardless.
   */
  "anomaly/check.trigger": {
    data: {
      productId: string;
      channelId: string;
      sku: string;
    };
  };
};

// ---------------------------------------------------------------------------
// Inngest client
// ---------------------------------------------------------------------------

export const inngest = new Inngest({
  id: "ecomsync",
  eventKey: process.env.INNGEST_EVENT_KEY ?? "local",
  // Route events to local dev server instead of Inngest cloud in development
  isDev: process.env.NODE_ENV !== "production",
});
