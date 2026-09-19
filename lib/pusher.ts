/**
 * lib/pusher.ts
 *
 * Server-side Pusher client for real-time event broadcasting.
 *
 * Channel naming convention:
 *   inventory-updates  — broadcast on every successful inventory mutation
 *   anomaly-alerts     — broadcast when an anomaly snapshot is created
 *
 * Event naming convention:
 *   inventory:updated  — { sku, channelName, quantity, delta, version }
 *   anomaly:detected   — { snapshotId, sku, channelName, score, explanation }
 */

import Pusher from "pusher";

// ---------------------------------------------------------------------------
// Singleton Pusher server client
// ---------------------------------------------------------------------------

let _pusher: Pusher | null = null;

export function getPusherServer(): Pusher {
  if (_pusher) return _pusher;

  const appId   = process.env.PUSHER_APP_ID;
  const key     = process.env.PUSHER_KEY;
  const secret  = process.env.PUSHER_SECRET;
  const cluster = process.env.PUSHER_CLUSTER ?? "us2";

  if (!appId || !key || !secret) {
    throw new Error(
      "Missing Pusher env vars: PUSHER_APP_ID, PUSHER_KEY, and PUSHER_SECRET are required."
    );
  }

  _pusher = new Pusher({ appId, key, secret, cluster, useTLS: true });
  return _pusher;
}

// ---------------------------------------------------------------------------
// Typed event payloads
// ---------------------------------------------------------------------------

export interface InventoryUpdatedPayload {
  sku: string;
  productName: string;
  channelName: string;
  channelId: string;
  productId: string;
  quantity: number;
  delta: number;
  version: number;
  syncedAt: string;
}

export interface AnomalyDetectedPayload {
  snapshotId: string;
  sku: string;
  productName: string;
  channelName: string;
  score: number;
  explanation: string;
  llmModel: string;
  ruleBreakdown: Record<string, unknown>;
  detectedAt: string;
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

export const CHANNELS = {
  INVENTORY: "inventory-updates",
  ANOMALIES: "anomaly-alerts",
} as const;

export const EVENTS = {
  INVENTORY_UPDATED: "inventory:updated",
  ANOMALY_DETECTED:  "anomaly:detected",
} as const;

/**
 * Broadcast an inventory update to all connected dashboard clients.
 */
export async function broadcastInventoryUpdate(
  payload: InventoryUpdatedPayload
): Promise<void> {
  const pusher = getPusherServer();
  await pusher.trigger(CHANNELS.INVENTORY, EVENTS.INVENTORY_UPDATED, payload);
}

/**
 * Broadcast an anomaly alert to all connected dashboard clients.
 */
export async function broadcastAnomalyAlert(
  payload: AnomalyDetectedPayload
): Promise<void> {
  const pusher = getPusherServer();
  await pusher.trigger(CHANNELS.ANOMALIES, EVENTS.ANOMALY_DETECTED, payload);
}
