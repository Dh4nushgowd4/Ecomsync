/**
 * scripts/simulate-concurrent.ts
 *
 * Concurrent webhook traffic simulator.
 *
 * Fires N simultaneous POST requests to the same SKU on the same channel
 * to demonstrate that the Redis distributed lock prevents race conditions.
 *
 * What to observe:
 *   1. All N requests are accepted immediately (HTTP 202) — the webhook
 *      handler is non-blocking and just queues an Inngest event.
 *   2. In the Inngest dashboard (http://localhost:8288), you'll see N
 *      function runs. They WILL execute concurrently — but each one
 *      acquires the Redis lock, so the actual DB writes are serialized.
 *   3. The final channel_inventory.quantity will be exactly:
 *      initial_quantity + (N × delta) — no lost updates.
 *
 * Run: npx tsx scripts/simulate-concurrent.ts [--sku SKU-001] [--n 10] [--delta -5]
 *
 * Prerequisites:
 *   - npm run dev  (Next.js dev server on port 3000)
 *   - npx inngest-cli@latest dev  (Inngest dev server on port 8288)
 *   - .env.local populated
 */

import { config } from "dotenv";
config({ path: ".env.local" });

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name: string, defaultValue: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
}

const SKU         = getArg("sku",     "SKU-001");
const CHANNEL     = getArg("channel", "shopify");
const CONCURRENCY = Number(getArg("n",       "10"));
const DELTA       = Number(getArg("delta",   "-5"));
const BASE_URL    = getArg("url", process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

interface WebhookResult {
  requestId: number;
  status:    number;
  body:      unknown;
  latencyMs: number;
  error?:    string;
}

async function fireWebhook(
  requestId: number,
  sku: string,
  channel: string,
  delta: number
): Promise<WebhookResult> {
  const url = `${BASE_URL}/api/webhooks/${channel}`;
  const body = JSON.stringify({ sku, delta, metadata: { requestId, simulatedAt: new Date().toISOString() } });
  const start = Date.now();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const responseBody = await res.json();
    return {
      requestId,
      status:    res.status,
      body:      responseBody,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      requestId,
      status:    0,
      body:      null,
      latencyMs: Date.now() - start,
      error:     String(err),
    };
  }
}

async function simulate() {
  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│  EcomSync — Concurrent Webhook Traffic Simulator        │");
  console.log("└─────────────────────────────────────────────────────────┘");
  console.log();
  console.log(`  Target URL : ${BASE_URL}/api/webhooks/${CHANNEL}`);
  console.log(`  SKU        : ${SKU}`);
  console.log(`  Channel    : ${CHANNEL}`);
  console.log(`  Concurrency: ${CONCURRENCY} simultaneous requests`);
  console.log(`  Delta each : ${DELTA > 0 ? "+" : ""}${DELTA} units`);
  console.log(`  Expected Δ : ${DELTA * CONCURRENCY} total units (if lock works correctly)`);
  console.log();
  console.log("  Firing requests...\n");

  const wallStart = Date.now();

  // Fire all requests simultaneously
  const promises = Array.from({ length: CONCURRENCY }, (_, i) =>
    fireWebhook(i + 1, SKU, CHANNEL, DELTA)
  );

  const results = await Promise.all(promises);
  const wallElapsed = Date.now() - wallStart;

  // ── Results summary ─────────────────────────────────────────────────────
  const accepted = results.filter((r) => r.status === 202);
  const rejected = results.filter((r) => r.status !== 202);
  const avgLatency =
    results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length;

  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│  Results                                                │");
  console.log("└─────────────────────────────────────────────────────────┘");
  console.log();
  console.log(`  Total requests   : ${CONCURRENCY}`);
  console.log(`  ✅ Accepted (202) : ${accepted.length}`);
  console.log(`  ❌ Rejected       : ${rejected.length}`);
  console.log(`  Wall time        : ${wallElapsed}ms`);
  console.log(`  Avg latency      : ${avgLatency.toFixed(1)}ms`);
  console.log();

  if (rejected.length > 0) {
    console.log("  Rejected responses:");
    rejected.forEach((r) => {
      console.log(`    #${r.requestId}: HTTP ${r.status} — ${JSON.stringify(r.body)}`);
    });
    console.log();
  }

  console.log("  Per-request latencies:");
  results.forEach((r) => {
    const statusEmoji = r.status === 202 ? "✅" : "❌";
    console.log(`    ${statusEmoji} #${String(r.requestId).padStart(2)}: ${r.latencyMs}ms (HTTP ${r.status})`);
  });

  console.log();
  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│  Next Steps                                             │");
  console.log("└─────────────────────────────────────────────────────────┘");
  console.log();
  console.log("  1. Open Inngest Dev Server → http://localhost:8288");
  console.log("     You should see", accepted.length, '"sync-channel-update" runs');
  console.log();
  console.log("  2. Watch the Redis lock in action — runs execute one at");
  console.log("     a time for the same SKU (serialized by the lock).");
  console.log();
  console.log("  3. After all runs complete, query Supabase:");
  console.log(`     SELECT quantity FROM channel_inventory`);
  console.log(`     WHERE product_id = (SELECT id FROM products WHERE sku = '${SKU}')`);
  console.log(`     Expected delta: ${DELTA * accepted.length} units applied`);
  console.log();
  console.log("  4. Check MongoDB raw_channel_payloads for all", accepted.length, "payloads");
}

simulate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Simulator failed:", err);
    process.exit(1);
  });
