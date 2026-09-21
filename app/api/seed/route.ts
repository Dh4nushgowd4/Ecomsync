/**
 * app/api/seed/route.ts
 *
 * Provides a 1-click REST endpoint to seed sample channels, products,
 * and multi-channel inventory directly from the dashboard UI.
 */

import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";

export const runtime = "nodejs";

const CHANNELS = [
  { name: "shopify" as const, config: { shop: "demo.myshopify.com", api_version: "2024-01" } },
  { name: "amazon" as const, config: { marketplace_id: "ATVPDKIKX0DER", region: "us-east-1" } },
  { name: "ebay"   as const, config: { site_id: 0, environment: "production" } },
];

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const PRODUCT_TEMPLATES = [
  { name: "Wireless Bluetooth Headphones Pro",  category: "Electronics" },
  { name: "Ergonomic Office Chair Deluxe",      category: "Furniture" },
  { name: "Stainless Steel Water Bottle 32oz",  category: "Kitchen" },
  { name: "Yoga Mat Premium Non-Slip",          category: "Sports" },
  { name: "LED Desk Lamp Adjustable",           category: "Office" },
  { name: "Mechanical Gaming Keyboard RGB",     category: "Electronics" },
  { name: "Bamboo Cutting Board Set",           category: "Kitchen" },
  { name: "Running Shoes Lightweight",          category: "Sports" },
  { name: "Smart WiFi Plug 4-Pack",             category: "Electronics" },
  { name: "Insulated Travel Coffee Mug",        category: "Kitchen" },
  { name: "Noise-Cancelling Earbuds",           category: "Electronics" },
  { name: "Standing Desk Converter",            category: "Furniture" },
  { name: "Resistance Bands Set 5-Pack",        category: "Sports" },
  { name: "Air Purifier HEPA Filter",           category: "Home" },
  { name: "Portable Phone Charger 20000mAh",    category: "Electronics" },
  { name: "Cast Iron Skillet 12-inch",          category: "Kitchen" },
  { name: "Foam Roller Deep Tissue",            category: "Sports" },
  { name: "Wireless Charging Pad Fast",         category: "Electronics" },
  { name: "Blackout Curtains Room Darkening",   category: "Home" },
  { name: "Stainless Steel Mixing Bowls Set",   category: "Kitchen" },
];

export async function POST() {
  try {
    const supabase = getSupabaseClient();

    // 1. Seed channels
    const { data: channels, error: channelErr } = await supabase
      .from("channels")
      .upsert(CHANNELS, { onConflict: "name" })
      .select();

    if (channelErr) throw channelErr;

    // 2. Seed products
    const productInserts = PRODUCT_TEMPLATES.map((p, i) => ({
      sku: `SKU-${String(i + 1).padStart(3, "0")}`,
      name: p.name,
      base_quantity: randomBetween(50, 500),
    }));

    const { data: products, error: productErr } = await supabase
      .from("products")
      .upsert(productInserts, { onConflict: "sku" })
      .select();

    if (productErr) throw productErr;

    // 3. Seed channel_inventory
    const inventoryInserts = products!.flatMap((product) =>
      channels!.map((channel) => ({
        product_id: product.id,
        channel_id: channel.id,
        quantity: Math.max(
          0,
          product.base_quantity +
            randomBetween(
              -Math.floor(product.base_quantity * 0.2),
              Math.floor(product.base_quantity * 0.2)
            )
        ),
        last_synced_at: new Date().toISOString(),
        version: 0,
      }))
    );

    const { error: invErr } = await supabase
      .from("channel_inventory")
      .upsert(inventoryInserts, { onConflict: "product_id,channel_id" });

    if (invErr) throw invErr;

    return NextResponse.json({
      success: true,
      channelsCount: channels?.length ?? 0,
      productsCount: products?.length ?? 0,
      inventoryCount: inventoryInserts.length,
      message: "Database successfully seeded with channels and products.",
    });
  } catch (err) {
    console.error("[api/seed] Error seeding database:", err);
    return NextResponse.json(
      { error: "Failed to seed database", details: String(err) },
      { status: 500 }
    );
  }
}
