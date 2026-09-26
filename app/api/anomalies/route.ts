/**
 * app/api/anomalies/route.ts
 *
 * Returns recent anomaly snapshots from MongoDB for the dashboard.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAnomalySnapshotsCollection } from "@/lib/mongo";

export const runtime = "nodejs";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "50"), 100);
    const minScore = parseInt(searchParams.get("minScore") ?? "0");

    const col = await getAnomalySnapshotsCollection();
    const filter = minScore > 0 ? { score: { $gte: minScore } } : {};
    const docs = await col
      .find(filter)
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();

    const anomalies = docs.map((d) => ({
      snapshotId: d._id?.toHexString() ?? "",
      sku: d.sku,
      productName: d.sku, // fallback — product name not stored in snapshot
      channelName: d.channel_name,
      score: d.score,
      explanation: d.explanation,
      llmModel: d.llm_model,
      detectedAt: d.created_at instanceof Date
        ? d.created_at.toISOString()
        : String(d.created_at),
    }));

    return NextResponse.json(anomalies);
  } catch (err) {
    console.error("[api/anomalies] Error:", err);
    return NextResponse.json(
      { error: "Failed to fetch anomalies", details: String(err) },
      { status: 500 }
    );
  }
}
