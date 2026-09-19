/**
 * app/api/inventory/route.ts
 *
 * Returns the full dashboard inventory view — used by the dashboard
 * on initial load and for SSR hydration.
 */

import { NextResponse } from "next/server";
import { getDashboardInventory } from "@/lib/supabase";

export const runtime = "nodejs";
export const revalidate = 0; // No cache — always fresh

export async function GET() {
  try {
    const data = await getDashboardInventory();
    return NextResponse.json(data);
  } catch (err) {
    console.error("[api/inventory] Error:", err);
    return NextResponse.json(
      { error: "Failed to fetch inventory", details: String(err) },
      { status: 500 }
    );
  }
}
