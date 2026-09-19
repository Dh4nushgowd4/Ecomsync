/**
 * lib/supabase.ts
 *
 * Server-side Supabase client using the service role key.
 * This client bypasses RLS — use ONLY in server-side code (Server Actions,
 * Route Handlers, Inngest functions). Never expose to the browser.
 *
 * For browser/client components, create a separate client with the anon key.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Type Definitions (mirrors the Postgres schema exactly)
// ---------------------------------------------------------------------------

export interface Product {
  id: string;
  sku: string;
  name: string;
  base_quantity: number;
  created_at: string;
}

export interface Channel {
  id: string;
  name: "shopify" | "amazon" | "ebay" | "walmart" | "etsy";
  config: Record<string, unknown>;
  created_at: string;
}

export interface ChannelInventory {
  product_id: string;
  channel_id: string;
  quantity: number;
  last_synced_at: string;
  version: number;
}

export interface SyncEvent {
  id: string;
  product_id: string;
  channel_id: string;
  delta: number;
  resulting_quantity: number;
  status: "success" | "failure" | "partial" | "retrying";
  error: string | null;
  created_at: string;
}

export interface InventoryDashboardRow {
  product_id: string;
  sku: string;
  name: string;
  base_quantity: number;
  channel_id: string;
  channel_name: string;
  channel_quantity: number;
  last_synced_at: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Database type map for typed client queries
// ---------------------------------------------------------------------------

export type Database = {
  public: {
    Tables: {
      products: { Row: Product; Insert: Omit<Product, "id" | "created_at">; Update: Partial<Omit<Product, "id">> };
      channels: { Row: Channel; Insert: Omit<Channel, "id" | "created_at">; Update: Partial<Omit<Channel, "id">> };
      channel_inventory: { Row: ChannelInventory; Insert: ChannelInventory; Update: Partial<ChannelInventory> };
      sync_events: { Row: SyncEvent; Insert: Omit<SyncEvent, "id" | "created_at">; Update: Partial<Omit<SyncEvent, "id">> };
    };
    Views: {
      inventory_dashboard: { Row: InventoryDashboardRow };
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

// ---------------------------------------------------------------------------
// Singleton client (reused across hot-reload and serverless invocations)
// ---------------------------------------------------------------------------

let _supabase: SupabaseClient<any> | null = null;

/**
 * Returns the singleton server-side Supabase client.
 * Validates that all required env vars are present at startup.
 */
export function getSupabaseClient(): SupabaseClient<any> {
  if (_supabase) return _supabase;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Missing Supabase environment variables: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required."
    );
  }

  _supabase = createClient<any>(url, serviceKey, {
    auth: {
      // Service role key — disable automatic session management
      persistSession: false,
      autoRefreshToken: false,
    },
    db: {
      schema: "public",
    },
  });

  return _supabase;
}

// ---------------------------------------------------------------------------
// Public client (anon key — safe for browser, respects RLS)
// ---------------------------------------------------------------------------

let _supabasePublic: SupabaseClient<any> | null = null;

export function getSupabasePublicClient(): SupabaseClient<any> {
  if (_supabasePublic) return _supabasePublic;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing Supabase env vars: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required."
    );
  }

  _supabasePublic = createClient<any>(url, anonKey);
  return _supabasePublic;
}

// Convenient default export: server-side client
export const supabase = {
  get client() {
    return getSupabaseClient();
  },
};

// ---------------------------------------------------------------------------
// Query helpers (reusable building blocks for Inngest functions & AI tools)
// ---------------------------------------------------------------------------

/**
 * Fetch a product by SKU. Returns null if not found.
 */
export async function getProductBySku(sku: string): Promise<Product | null> {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from("products")
    .select("*")
    .eq("sku", sku)
    .single();

  if (error && error.code !== "PGRST116") throw error; // PGRST116 = not found
  return data ?? null;
}

/**
 * Fetch channel_inventory row for a specific product+channel combo.
 */
export async function getChannelInventory(
  productId: string,
  channelId: string
): Promise<ChannelInventory | null> {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from("channel_inventory")
    .select("*")
    .eq("product_id", productId)
    .eq("channel_id", channelId)
    .single();

  if (error && error.code !== "PGRST116") throw error;
  return data ?? null;
}

/**
 * Optimistic-concurrency update of channel_inventory.
 * Only succeeds if the current `version` in the DB matches `expectedVersion`.
 * Returns true on success, false on version conflict.
 */
export async function updateChannelInventoryOCC(
  productId: string,
  channelId: string,
  newQuantity: number,
  expectedVersion: number
): Promise<boolean> {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from("channel_inventory")
    .update({
      quantity: newQuantity,
      last_synced_at: new Date().toISOString(),
      version: expectedVersion + 1,
    })
    .eq("product_id", productId)
    .eq("channel_id", channelId)
    .eq("version", expectedVersion) // OCC check
    .select("version");

  if (error) throw error;
  return (data?.length ?? 0) > 0; // 0 rows updated = version mismatch
}

/**
 * Upsert channel_inventory (used for initial setup / seeding).
 */
export async function upsertChannelInventory(
  row: ChannelInventory
): Promise<void> {
  const db = getSupabaseClient();
  const { error } = await db
    .from("channel_inventory")
    .upsert(row, { onConflict: "product_id,channel_id" });
  if (error) throw error;
}

/**
 * Append a sync event to the audit log.
 */
export async function insertSyncEvent(
  event: Omit<SyncEvent, "id" | "created_at">
): Promise<SyncEvent> {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from("sync_events")
    .insert(event)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Fetch the N most recent sync events for anomaly scanning.
 */
export async function getRecentSyncEvents(
  limitMinutes: number = 15,
  limit: number = 500
): Promise<SyncEvent[]> {
  const db = getSupabaseClient();
  const since = new Date(Date.now() - limitMinutes * 60_000).toISOString();
  const { data, error } = await db
    .from("sync_events")
    .select("*")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/**
 * Fetch dashboard inventory view.
 */
export async function getDashboardInventory(): Promise<InventoryDashboardRow[]> {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from("inventory_dashboard")
    .select("*");
  if (error) throw error;
  return data ?? [];
}
