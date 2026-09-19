/**
 * app/api/chat/route.ts
 *
 * Streaming tool-calling chat API route.
 * Uses a custom agentic loop because Gemini doesn't auto-continue after tool calls.
 * Powered by Vercel AI SDK + @ai-sdk/google.
 */

import { generateText, tool } from "ai";
import { google } from "@ai-sdk/google";
import { NextRequest } from "next/server";
import { getLangfuse } from "@/lib/langfuse";
import { getSupabaseClient } from "@/lib/supabase";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

const PRIMARY_MODEL  = process.env.PRIMARY_MODEL  ?? "gemini-3.6-flash";
const FALLBACK_MODEL = process.env.FALLBACK_MODEL ?? "gemini-3.5-flash";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRateLimitError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("resource_exhausted")
  );
}

function isModelUnavailableError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? "").toLowerCase();
  return msg.includes("404") || msg.includes("not found") || msg.includes("no longer available");
}

function isEmptyOutputError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? "").toLowerCase();
  return msg.includes("must contain either output text or tool calls") || msg.includes("output text or tool");
}

// Retry on transient errors (5xx, network, empty output), but NOT on rate limits (cascade instead)
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isTransient =
        !isRateLimitError(err) &&
        !isModelUnavailableError(err) &&
        (isEmptyOutputError(err) ||
          String((err as any)?.message ?? "").includes("5") ||
          String((err as any)?.message ?? "").includes("network"));
      if (isTransient && i < maxRetries - 1) {
        await sleep(2000 * (i + 1));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}

const SYSTEM_PROMPT = `You are EcomSync AI, an intelligent inventory management assistant for 
a multi-channel e-commerce operation selling on Shopify, Amazon, and eBay.

You have access to real-time inventory data through tools. Always use the tools to fetch 
live data before answering questions about stock levels, anomalies, or channel health.

After receiving tool results, always respond with a clear, helpful text summary of what you found.
Be concise, precise, and actionable. Format numbers clearly.

Available channels: shopify, amazon, ebay, walmart, etsy`;

// ---------------------------------------------------------------------------
// Tool definitions (with execute handlers)
// ---------------------------------------------------------------------------

const inventoryTools = {
  getInventoryForSku: tool({
    description: "Get real-time inventory levels for a specific SKU across all channels.",
    parameters: z.object({
      sku: z.string().describe("The SKU code to look up, e.g. SKU-001"),
    }),
    execute: async ({ sku }) => {
      const db = getSupabaseClient();
      const { data, error } = await db
        .from("inventory_dashboard")
        .select("*")
        .eq("sku", sku);
      if (error) throw new Error(error.message);
      if (!data?.length) return { error: `SKU ${sku} not found in inventory` };
      return {
        sku: data[0].sku,
        productName: data[0].name,
        baseQuantity: data[0].base_quantity,
        channels: data.map((r) => ({
          channel: r.channel_name,
          quantity: r.channel_quantity,
          lastSyncedAt: r.last_synced_at,
        })),
        totalChannelQuantity: data.reduce((s, r) => s + (r.channel_quantity ?? 0), 0),
      };
    },
  }),

  listAllInventory: tool({
    description: "Get inventory overview for all products across all channels.",
    parameters: z.object({}),
    execute: async () => {
      const db = getSupabaseClient();
      const { data, error } = await db
        .from("inventory_dashboard")
        .select("sku,name,base_quantity,channel_name,channel_quantity,last_synced_at");
      if (error) throw new Error(error.message);
      return { items: data ?? [], count: data?.length ?? 0 };
    },
  }),

  getChannelHealth: tool({
    description: "Check the sync health and stock levels for a specific sales channel.",
    parameters: z.object({
      channel: z.enum(["shopify", "amazon", "ebay", "walmart", "etsy"]),
    }),
    execute: async ({ channel }) => {
      const db = getSupabaseClient();
      const { data, error } = await db
        .from("inventory_dashboard")
        .select("*")
        .eq("channel_name", channel);
      if (error) throw new Error(error.message);
      const total = data?.length ?? 0;
      const recentlySynced = (data ?? []).filter((r) => {
        const syncTime = new Date(r.last_synced_at).getTime();
        return Date.now() - syncTime < 24 * 60 * 60 * 1000;
      }).length;
      return {
        channel,
        totalProducts: total,
        recentlySynced,
        syncRate: total ? Math.round((recentlySynced / total) * 100) : 0,
        status: total && recentlySynced / total > 0.9 ? "healthy" : "degraded",
        products: (data ?? []).map((r) => ({ sku: r.sku, quantity: r.channel_quantity })),
      };
    },
  }),

  getAnomalies: tool({
    description: "Retrieve recently detected inventory anomalies.",
    parameters: z.object({
      limit: z.number().optional().describe("Max anomalies to return (default 10)"),
    }),
    execute: async ({ limit = 10 }) => {
      const db = getSupabaseClient();
      const { data, error } = await db
        .from("anomaly_snapshots")
        .select("sku,product_name,channel_name,anomaly_score,explanation,detected_at")
        .order("detected_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return { anomalies: data ?? [], count: data?.length ?? 0 };
    },
  }),
};

// ---------------------------------------------------------------------------
// Custom agentic loop: runs tool calls then gets a text answer
// ---------------------------------------------------------------------------

async function runAgentLoop(
  modelId: string,
  initialMessages: Array<{ role: string; content: any }>
): Promise<string> {
  const MAX_STEPS = 5;
  let messages: any[] = [...initialMessages];

  for (let step = 0; step < MAX_STEPS; step++) {
    const result = await withRetry(() =>
      generateText({
        model: google(modelId),
        system: SYSTEM_PROMPT,
        messages,
        tools: inventoryTools,
        maxTokens: 2048,
      })
    );

    if (result.finishReason === "stop" || !result.toolCalls?.length) {
      return result.text || "I couldn't find an answer. Please try again.";
    }

    if (result.finishReason === "tool-calls" && result.toolCalls?.length) {
      // Append the assistant's tool-call turn (from response.messages)
      messages = [...messages, ...result.response.messages];

      // Execute each tool and append tool results in SDK v7 format
      const toolResultContent = await Promise.all(
        result.toolCalls.map(async (tc) => {
          const toolFn = inventoryTools[tc.toolName as keyof typeof inventoryTools];
          let output: unknown;
          try {
            // @ts-ignore — dynamic call with typed args
            output = await toolFn.execute(tc.input as any, { messages, toolCallId: tc.toolCallId });
          } catch (err) {
            output = { error: String(err) };
          }
          return {
            type: "tool-result" as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            output: { type: "json" as const, value: output },
          };
        })
      );

      messages.push({ role: "tool", content: toolResultContent });
      continue;
    }

    return result.text || "No response generated.";
  }

  return "I hit my processing limit. Please try a simpler question.";
}

// ---------------------------------------------------------------------------
// POST handler — streams the final answer after the agentic loop
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const langfuse = getLangfuse();
  const body = await req.json();

  // Convert UIMessage array → simple CoreMessage array for the agentic loop
  const uiMessages: Array<{
    role: string;
    parts?: Array<{ type: string; text?: string }>;
    content?: string;
  }> = body.messages ?? [];

  const messages: Array<{ role: string; content: string }> = uiMessages
    .map((m) => ({
      role: m.role,
      content: m.parts
        ? m.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("")
        : m.content ?? "",
    }))
    .filter((m) => m.content.trim().length > 0);

  const trace = langfuse.trace({
    name: "chat-session",
    input: messages,
  });

  const startMs = Date.now();

  async function tryModel(modelId: string): Promise<string> {
    return runAgentLoop(modelId, [...messages]);
  }

  let finalText = "";
  let modelUsed = PRIMARY_MODEL;

  try {
    finalText = await tryModel(PRIMARY_MODEL);
  } catch (primaryErr) {
    const isExhausted = isRateLimitError(primaryErr) || isModelUnavailableError(primaryErr);
    console.warn(`Primary model (${PRIMARY_MODEL}) failed (exhausted=${isExhausted}):`, String((primaryErr as any)?.message ?? "").slice(0, 120));
    modelUsed = FALLBACK_MODEL;
    try {
      finalText = await tryModel(FALLBACK_MODEL);
    } catch (fallbackErr) {
      const isRateErr = isRateLimitError(fallbackErr);
      if (isRateErr) {
        finalText = "⚠️ The AI quota for today has been exhausted on both models. This is a free-tier limit (20 requests/day per model). Please try again tomorrow, or add billing to your Google AI Studio project for unlimited access.";
      } else {
        finalText = "I'm having trouble connecting to the AI service right now. Please try again in a moment.";
      }
      console.error("Both models failed:", fallbackErr);
    }
  }

  // Log to Langfuse
  const generation = trace.generation({
    name: `chat-${modelUsed}`,
    model: modelUsed,
    input: messages,
    startTime: new Date(startMs),
  });
  generation.end({
    output: finalText,
    metadata: { latency_ms: Date.now() - startMs, model_used: modelUsed },
  });
  trace.update({ output: finalText });
  langfuse.flushAsync().catch(() => {});

  // Return the final answer as a plain data stream — no extra model call needed
  const encoder = new TextEncoder();
  const responseBody = new ReadableStream({
    start(controller) {
      const lines = [
        `data: ${JSON.stringify({ type: "start" })}\n\n`,
        `data: ${JSON.stringify({ type: "start-step" })}\n\n`,
        `data: ${JSON.stringify({ type: "text-start", id: "0" })}\n\n`,
        `data: ${JSON.stringify({ type: "text-delta", id: "0", delta: finalText })}\n\n`,
        `data: ${JSON.stringify({ type: "text-end", id: "0" })}\n\n`,
        `data: ${JSON.stringify({ type: "finish-step" })}\n\n`,
        `data: ${JSON.stringify({ type: "finish", finishReason: "stop" })}\n\n`,
        `data: [DONE]\n\n`,
      ];
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });

  return new Response(responseBody, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
