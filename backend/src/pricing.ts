/**
 * Rough dollar-cost estimation for token usage (issue #19).
 *
 * Copilot bills in AI Units, but developers want a familiar dollar figure. We
 * keep a small, approximate price list (USD per 1M tokens) keyed by the model
 * that produced the tokens and derive a best-effort estimate. These rates are
 * intentionally rough ball-parks for comparison, not billing-accurate numbers,
 * and can be overridden with the MODEL_PRICING env var (JSON).
 */

export interface ModelRate {
  /** USD per 1M input (prompt) tokens. */
  input: number;
  /** USD per 1M output (completion) tokens. */
  output: number;
}

/** Rough USD-per-1M-token rates. Used when a model has no explicit entry. */
export const DEFAULT_RATE: ModelRate = { input: 3, output: 15 };

/** Approximate USD-per-1M-token rates by model id (see MODEL_OPTIONS in the UI). */
const BUILTIN_PRICING: Record<string, ModelRate> = {
  "gpt-5.5": { input: 1.25, output: 10 },
  "gpt-5.3-codex": { input: 1.25, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4.5": { input: 3, output: 15 },
  "claude-opus-4.8": { input: 15, output: 75 },
  "claude-haiku-4.5": { input: 1, output: 5 },
  "gemini-3.1-pro-preview": { input: 1.25, output: 10 },
};

function loadPricing(): Record<string, ModelRate> {
  const raw = process.env.MODEL_PRICING;
  if (!raw) return { ...BUILTIN_PRICING };
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ModelRate>>;
    const merged: Record<string, ModelRate> = { ...BUILTIN_PRICING };
    for (const [model, rate] of Object.entries(parsed)) {
      merged[model] = {
        input: Number(rate.input ?? DEFAULT_RATE.input),
        output: Number(rate.output ?? DEFAULT_RATE.output),
      };
    }
    return merged;
  } catch {
    return { ...BUILTIN_PRICING };
  }
}

export const MODEL_PRICING: Record<string, ModelRate> = loadPricing();

/** Rough rate for a model, falling back to DEFAULT_RATE for unknown/absent ids. */
export function rateFor(model: string | null | undefined): ModelRate {
  if (!model) return DEFAULT_RATE;
  return MODEL_PRICING[model] ?? DEFAULT_RATE;
}

/** Best-effort dollar estimate for a single (model, tokens) attempt. */
export function estimateUsd(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  const r = rateFor(model);
  return (inputTokens * r.input + outputTokens * r.output) / 1_000_000;
}

/**
 * Build a SQLite expression that computes the estimated USD for the given
 * token/model columns, so per-model estimates can be summed inside aggregate
 * queries (reports). Rates are compiled into CASE branches; all values are
 * constants from our own price list, so the expression is safe to inline.
 */
export function sqlEstimatedUsd(inputCol: string, outputCol: string, modelCol: string): string {
  const branch = (pick: "input" | "output") => {
    const whens = Object.entries(MODEL_PRICING)
      .map(([model, rate]) => `WHEN ${sqlStr(model)} THEN ${rate[pick] / 1_000_000}`)
      .join(" ");
    return `CASE ${modelCol} ${whens} ELSE ${DEFAULT_RATE[pick] / 1_000_000} END`;
  };
  return `(${inputCol} * (${branch("input")}) + ${outputCol} * (${branch("output")}))`;
}

function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
