/**
 * scripts/seed.ts
 *
 * Seeds the database with:
 *   - 3 channels: shopify, amazon, ebay
 *   - 20 products with randomized starting inventory
 *   - channel_inventory rows for every product × channel combination
 *
 * Run: npx ts-node --project tsconfig.scripts.json scripts/seed.ts
 * Or:  npx tsx scripts/seed.ts
 *
 * Requires: .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *           and MONGODB_URI
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import type { Database } from "@/lib/supabase";

/*
 * We intentionally delay runtime imports until after dotenv has populated
 * process.env. Static imports are evaluated before this module body runs,
 * which would otherwise leave MONGODB_URI and Supabase settings unset.
 */

// ---------------------------------------------------------------------------
// Supabase client (bypass RLS)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------

async function seed() {
  const { createClient } = await import("@supabase/supabase-js");
  const { ensureMongoIndexes } = await import("@/lib/mongo");

  const supabase = createClient<any>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  console.log("🌱 Starting EcomSync seed...\n");

  // ── 1. Upsert channels ──────────────────────────────────────────────────
  console.log("📡 Seeding channels...");
  const { data: channels, error: channelErr } = await supabase
    .from("channels")
    .upsert(CHANNELS, { onConflict: "name" })
    .select();

  if (channelErr) throw channelErr;
  console.log(`   ✅ ${channels!.length} channels seeded: ${channels!.map((c) => c.name).join(", ")}`);

  // ── 2. Upsert products ──────────────────────────────────────────────────
  console.log("\n📦 Seeding products...");
  const productInserts = PRODUCT_TEMPLATES.map((p, i) => ({
    sku:           `SKU-${String(i + 1).padStart(3, "0")}`,
    name:          p.name,
    base_quantity: randomBetween(50, 500),
  }));

  const { data: products, error: productErr } = await supabase
    .from("products")
    .upsert(productInserts, { onConflict: "sku" })
    .select();

  if (productErr) throw productErr;
  console.log(`   ✅ ${products!.length} products seeded`);

  // ── 3. Upsert channel_inventory ─────────────────────────────────────────
  console.log("\n🔢 Seeding channel inventory...");
  const inventoryInserts = products!.flatMap((product) =>
    channels!.map((channel) => ({
      product_id:     product.id,
      channel_id:     channel.id,
      // Each channel has slightly different quantity (±20% of base)
      quantity:       Math.max(
        0,
        product.base_quantity + randomBetween(
          -Math.floor(product.base_quantity * 0.2),
          Math.floor(product.base_quantity * 0.2)
        )
      ),
      last_synced_at: new Date().toISOString(),
      version:        0,
    }))
  );

  const { error: invErr } = await supabase
    .from("channel_inventory")
    .upsert(inventoryInserts, { onConflict: "product_id,channel_id" });

  if (invErr) throw invErr;
  console.log(`   ✅ ${inventoryInserts.length} inventory rows seeded (${products!.length} products × ${channels!.length} channels)`);

  // ── 4. Ensure MongoDB indexes ────────────────────────────────────────────
  console.log("\n🍃 Ensuring MongoDB indexes...");
  await ensureMongoIndexes();
  console.log("   ✅ MongoDB TTL and query indexes created");

  // ── 5. Summary ───────────────────────────────────────────────────────────
  console.log("\n✨ Seed complete! Summary:");
  console.log("─".repeat(50));
  products!.forEach((p) => {
    const chQtys = channels!.map((ch) => {
      const inv = inventoryInserts.find(
        (i) => i.product_id === p.id && i.channel_id === ch.id
      );
      return `${ch.name}: ${inv?.quantity ?? "?"}`;
    }).join(" | ");
    console.log(`  ${p.sku.padEnd(10)} ${p.name.substring(0, 35).padEnd(36)} [base: ${p.base_quantity.toString().padStart(4)}] ${chQtys}`);
  });
  console.log("─".repeat(50));
  console.log("\n🚀 Run the dev server: npm run dev");
  console.log("📡 Run concurrent sim: npx tsx scripts/simulate-concurrent.ts");
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  });
