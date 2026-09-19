import { config } from "dotenv";
config({ path: ".env.local" });

import { getRecentSyncEvents, getProductBySku } from "@/lib/supabase";
import { computeAnomalyScore } from "@/lib/scoring";
import { generateAnomalyExplanation } from "@/lib/ai/fallback";
import { saveAnomalySnapshot } from "@/lib/mongo";
import { broadcastAnomalyAlert } from "@/lib/pusher";

async function runAnomalyScan() {
  console.log("🔍 Scanning for inventory anomalies...");
  const events = await getRecentSyncEvents(60, 500);
  console.log(`Found ${events.length} recent sync events.`);
  if (events.length === 0) return;

  const event = events[0];
  const product = await getProductBySku("SKU-012");
  if (!product) return;

  const scoreResult = computeAnomalyScore({
    delta: event.delta,
    resultingQuantity: event.resulting_quantity,
    baseQuantity: product.base_quantity,
    recentEvents: events,
    channelId: event.channel_id,
  });

  console.log(`📊 Computed Anomaly Score for SKU-012: ${scoreResult.score}/100`);

  if (scoreResult.score >= 60) {
    console.log("🤖 Generating AI anomaly explanation using Gemini...");
    const explanationResult = await generateAnomalyExplanation({
      sku: "SKU-012",
      channelName: "shopify",
      delta: event.delta,
      resultingQuantity: event.resulting_quantity,
      baseQuantity: product.base_quantity,
      score: scoreResult.score,
      scoringResult: scoreResult,
    });

    const explanation = explanationResult.text;

    console.log("\n📝 Gemini Explanation:");
    console.log(explanation);

    const docId = await saveAnomalySnapshot({
      sku: "SKU-012",
      product_name: product.name,
      channel_name: "shopify",
      score: scoreResult.score,
      explanation,
      llm_model: "gemini-3.5-flash",
      rule_breakdown: scoreResult.rules,
      created_at: new Date(),
    });

    console.log(`\n💾 Saved anomaly snapshot to MongoDB ID: ${docId}`);

    await broadcastAnomalyAlert({
      snapshotId: docId,
      sku: "SKU-012",
      productName: product.name,
      channelName: "shopify",
      score: scoreResult.score,
      explanation,
      llmModel: "gemini-3.5-flash",
      ruleBreakdown: scoreResult.rules,
      detectedAt: new Date().toISOString(),
    });

    console.log("📡 Broadcasted real-time anomaly alert to dashboard!");
  } else {
    console.log("No high severity anomalies detected (score < 60).");
  }
}

runAnomalyScan()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
