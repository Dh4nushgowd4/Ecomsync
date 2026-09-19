/**
 * lib/langfuse.ts
 *
 * Langfuse LLM observability integration.
 *
 * Wraps every model call in a Langfuse trace with a generation span that
 * records: model name, latency, token usage, prompt/completion, and which
 * model (primary vs fallback) ultimately served the request.
 *
 * Usage:
 *   import { tracedGenerate } from "@/lib/langfuse";
 *   const result = await tracedGenerate({
 *     traceName: "anomaly-explanation",
 *     input: { sku, score },
 *     fn: async (generation) => {
 *       const { text } = await generateText({ ... });
 *       generation.update({ output: text, usage: { ... } });
 *       return text;
 *     }
 *   });
 */

import { Langfuse } from "langfuse";

// Inferred locally — avoids any named export that may not exist in all langfuse versions
type LangfuseTrace = ReturnType<Langfuse["trace"]>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _LangfuseAlias = LangfuseTrace;

// ---------------------------------------------------------------------------
// Singleton Langfuse client
// ---------------------------------------------------------------------------

let _langfuse: Langfuse | null = null;

export function getLangfuse(): Langfuse {
  if (_langfuse) return _langfuse;

  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const baseUrl   = process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";

  if (!secretKey || !publicKey) {
    throw new Error(
      "Missing Langfuse env vars: LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY are required."
    );
  }

  _langfuse = new Langfuse({ secretKey, publicKey, baseUrl });
  return _langfuse;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface TracedGenerateOptions<T> {
  /** Human-readable name for the top-level trace */
  traceName: string;
  /** Model name being called (used for generation span metadata) */
  modelName: string;
  /** Arbitrary metadata attached to the trace */
  metadata?: Record<string, unknown>;
  /** Input passed to the model (logged as generation input) */
  input: unknown;
  /**
   * Callback that performs the actual model call.
   * Receives a `updateSpan` function to record output and token usage
   * before returning.
   */
  fn: (updateSpan: (output: unknown, usage?: TokenUsage) => void) => Promise<T>;
}

// ---------------------------------------------------------------------------
// Core tracing wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps an LLM call in a Langfuse trace + generation span.
 * Records model name, latency, input, output, and token usage automatically.
 *
 * The returned value is whatever `fn` returns.
 */
export async function tracedGenerate<T>(
  options: TracedGenerateOptions<T>
): Promise<T> {
  const langfuse = getLangfuse();
  const { traceName, modelName, metadata, input, fn } = options;

  const trace = langfuse.trace({
    name: traceName,
    metadata: {
      ...metadata,
      model: modelName,
      timestamp: new Date().toISOString(),
    },
    input,
  });

  const generation = trace.generation({
    name: `${traceName}-generation`,
    model: modelName,
    input,
    startTime: new Date(),
  });

  const startMs = Date.now();
  let output: unknown;
  let error: unknown;

  const updateSpan = (out: unknown, usage?: TokenUsage): void => {
    output = out;
    generation.update({
      output: out,
      usage: usage
        ? {
            input: usage.promptTokens,
            output: usage.completionTokens,
            total: usage.totalTokens,
            unit: "TOKENS",
          }
        : undefined,
    });
  };

  try {
    const result = await fn(updateSpan);
    return result;
  } catch (err) {
    error = err;
    generation.update({ output: `ERROR: ${String(err)}` });
    throw err;
  } finally {
    const latencyMs = Date.now() - startMs;
    generation.end({
      endTime: new Date(),
      metadata: {
        latency_ms: latencyMs,
        had_error: error !== undefined,
      },
    });
    trace.update({
      metadata: {
        ...metadata,
        model: modelName,
        latency_ms: latencyMs,
        had_error: error !== undefined,
      },
      output,
    });
    // Flush async — don't await to avoid blocking the response
    langfuse.flushAsync().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Convenience: log a fallback event to an existing trace
// ---------------------------------------------------------------------------

/**
 * Appends a "model_fallback" span to an existing Langfuse trace.
 * Call this when the primary model fails and we retry with a secondary.
 */
export function logFallbackEvent(
  trace: LangfuseTrace,
  primaryModel: string,
  fallbackModel: string,
  reason: string
): void {
  trace.event({
    name: "model_fallback",
    metadata: {
      primary_model: primaryModel,
      fallback_model: fallbackModel,
      reason,
      timestamp: new Date().toISOString(),
    },
  });
}

// Re-export the inferred trace type for consumers
export type { LangfuseTrace };
