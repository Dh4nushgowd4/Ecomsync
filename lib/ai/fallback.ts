/**
 * lib/ai/fallback.ts
 *
 * LLM fallback chain with Langfuse tracing.
 *
 * Tries the PRIMARY model first. On any error (network, timeout, API error),
 * waits for the configured timeout and then retries with the FALLBACK model.
 * Every call — including which model ultimately served the request — is
 * recorded as a Langfuse trace attribute.
 *
 * Exported functions:
 *   generateWithFallback   — single-shot text generation
 *   streamWithFallback     — streaming text (returns a ReadableStream)
 *   generateAnomalyExplanation — domain-specific wrapper for anomaly text
 */

import { generateText, streamText, GenerateTextResult, StreamTextResult } from "ai";
import { google } from "@ai-sdk/google";
import { getLangfuse, tracedGenerate, logFallbackEvent, TokenUsage } from "@/lib/langfuse";
import type { ScoringResult } from "@/lib/scoring";

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

const PRIMARY_MODEL  = process.env.PRIMARY_MODEL  ?? "gemini-3.6-flash";
const FALLBACK_MODEL = process.env.FALLBACK_MODEL ?? "gemini-3.5-flash";
const TIMEOUT_MS     = Number(process.env.LLM_TIMEOUT_MS ?? "15000");

function getModel(modelName: string) {
  return google(modelName);
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`LLM request timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// ---------------------------------------------------------------------------
// generateWithFallback
// ---------------------------------------------------------------------------

export interface GenerateFallbackOptions {
  traceName: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface GenerateFallbackResult {
  text: string;
  modelUsed: string;
  usedFallback: boolean;
  usage: TokenUsage;
}

/**
 * Attempts text generation with the primary model.
 * Falls back to the secondary model on any error or timeout.
 * All calls are traced in Langfuse.
 */
export async function generateWithFallback(
  opts: GenerateFallbackOptions
): Promise<GenerateFallbackResult> {
  const langfuse = getLangfuse();
  const { traceName, system, prompt, maxTokens = 1024, metadata } = opts;

  // Outer Langfuse trace to track the full request lifecycle
  const trace = langfuse.trace({
    name: traceName,
    metadata: {
      ...metadata,
      primary_model: PRIMARY_MODEL,
      fallback_model: FALLBACK_MODEL,
    },
    input: { system, prompt },
  });

  // ── Try primary model ──────────────────────────────────────────────────────
  let usedFallback = false;
  let modelUsed = PRIMARY_MODEL;

  async function tryModel(modelName: string): Promise<GenerateTextResult<Record<string, never>, never>> {
    const generation = trace.generation({
      name: `${traceName}-${modelName}`,
      model: modelName,
      input: { system, prompt },
      startTime: new Date(),
    });

    const startMs = Date.now();
    try {
      const result = await withTimeout(
        generateText({
          model: getModel(modelName),
          system,
          prompt,
          maxTokens,
        }),
        TIMEOUT_MS
      );

      const latency = Date.now() - startMs;
      generation.end({
        output: result.text,
        usage: {
          input:  result.usage?.promptTokens,
          output: result.usage?.completionTokens,
          total:  result.usage?.totalTokens,
          unit: "TOKENS",
        },
        metadata: { latency_ms: latency, model_used: modelName },
      });

      return result;
    } catch (err) {
      const latency = Date.now() - startMs;
      generation.end({
        output: `ERROR: ${String(err)}`,
        metadata: { latency_ms: latency, had_error: true },
      });
      throw err;
    }
  }

  let result: GenerateTextResult<Record<string, never>, never>;

  try {
    result = await tryModel(PRIMARY_MODEL);
  } catch (primaryErr) {
    // Log the fallback event
    logFallbackEvent(trace, PRIMARY_MODEL, FALLBACK_MODEL, String(primaryErr));
    usedFallback = true;
    modelUsed = FALLBACK_MODEL;

    try {
      result = await tryModel(FALLBACK_MODEL);
    } catch (fallbackErr) {
      trace.update({
        metadata: { fatal: true, error: String(fallbackErr) },
        output: "Both models failed",
      });
      await langfuse.flushAsync().catch(() => {});
      throw new Error(
        `Both primary (${PRIMARY_MODEL}) and fallback (${FALLBACK_MODEL}) models failed. ` +
        `Primary: ${String(primaryErr)}. Fallback: ${String(fallbackErr)}`
      );
    }
  }

  trace.update({
    metadata: {
      ...metadata,
      model_used: modelUsed,
      used_fallback: usedFallback,
    },
    output: result.text,
  });

  await langfuse.flushAsync().catch(() => {});

  return {
    text: result.text,
    modelUsed,
    usedFallback,
    usage: {
      promptTokens:     result.usage?.promptTokens,
      completionTokens: result.usage?.completionTokens,
      totalTokens:      result.usage?.totalTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// streamWithFallback
// ---------------------------------------------------------------------------

/**
 * Returns a streaming text result with automatic fallback.
 * If the primary model fails before streaming starts, switches to fallback.
 * Note: mid-stream errors after first chunk cannot retry transparently.
 */
export async function streamWithFallback(
  opts: GenerateFallbackOptions
): Promise<{ stream: StreamTextResult<Record<string, never>, never>; modelUsed: string }> {
  const { system, prompt, maxTokens = 2048 } = opts;

  async function tryStream(modelName: string) {
    return streamText({
      model: getModel(modelName),
      system,
      prompt,
      maxTokens,
    });
  }

  try {
    const stream = await tryStream(PRIMARY_MODEL);
    return { stream, modelUsed: PRIMARY_MODEL };
  } catch {
    const stream = await tryStream(FALLBACK_MODEL);
    return { stream, modelUsed: FALLBACK_MODEL };
  }
}

// ---------------------------------------------------------------------------
// Domain-specific wrapper: anomaly explanation
// ---------------------------------------------------------------------------

export interface AnomalyExplanationInput {
  sku: string;
  channelName: string;
  score: number;
  scoringResult: ScoringResult;
  baseQuantity: number;
  delta: number;
  resultingQuantity: number;
}

/**
 * Generates a plain-English explanation of an inventory anomaly using the
 * LLM fallback chain, fully traced in Langfuse.
 */
export async function generateAnomalyExplanation(
  input: AnomalyExplanationInput
): Promise<GenerateFallbackResult> {
  const { sku, channelName, score, scoringResult, baseQuantity, delta, resultingQuantity } =
    input;

  const { rules } = scoringResult;
  const triggeredRules = Object.entries(rules)
    .filter(([, v]) => v.triggered)
    .map(([k, v]) => `• ${k.replace(/_/g, " ")}: ${v.detail}`)
    .join("\n");

  const system = `You are an inventory intelligence assistant for an e-commerce operations team. 
Your job is to produce clear, concise, actionable anomaly reports in plain English.
Keep explanations under 150 words. Avoid jargon. Be specific about what the numbers mean.`;

  const prompt = `An inventory anomaly was detected with severity score ${score}/100.

Product SKU: ${sku}
Channel: ${channelName}
Base quantity (canonical): ${baseQuantity}
Delta applied: ${delta > 0 ? "+" : ""}${delta}
Resulting channel quantity: ${resultingQuantity}

Rules that triggered:
${triggeredRules || "No specific rules triggered (general threshold exceeded)"}

Please write a 2-3 sentence plain-English explanation of what likely happened and 
what the operations team should check. Be direct and actionable.`;

  try {
    return await generateWithFallback({
      traceName: "anomaly-explanation",
      system,
      prompt,
      maxTokens: 200,
      metadata: { sku, channelName, score },
    });
  } catch (err) {
    const fallbackText = `[Severity Score ${score}/100] High anomaly detected for SKU ${sku} on ${channelName}. Delta of ${delta} resulted in a channel quantity of ${resultingQuantity} relative to base quantity ${baseQuantity}.\nTriggered Rules:\n${triggeredRules}`;
    return {
      text: fallbackText,
      modelUsed: "rule-engine-fallback",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
}
