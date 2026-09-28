/**
 * Cost estimation for LLM calls.
 *
 * These are ESTIMATES from a dated static price table, not actual billed cost.
 * Pricing as of 2026-09 (Vercel AI Gateway published rates; see
 * https://vercel.com/docs/ai-gateway). USD per 1M tokens — re-verify before
 * trusting any figure; the table goes stale.
 *
 * Honesty rules (work package 1a):
 *   - An unknown price is UNKNOWN, never 0 / "free": `estimatedUSD` is `null`
 *     and `status` is `'unknown'`. Unknown is not free.
 *   - `openrouter/auto` cannot be priced statically: OpenRouter selects the
 *     concrete model per request, so its billable rate is unknown here rather
 *     than a guessed blended figure.
 *   - Local compute is not billed through the provider API, but that does not
 *     make it zero cost (hardware, energy and opportunity costs are real and
 *     unmeasured here) — so local is reported as unknown too.
 *   - A known published free-tier rate ($0) is a known static estimate of zero,
 *     which is distinct from "unknown".
 */

const PRICING_DATE = '2026-09';

const PRICING: Record<string, { inputPrice: number; outputPrice: number }> = {
  // OpenAI (via gateway)
  'openai/gpt-4o': { inputPrice: 5, outputPrice: 15 },
  'openai/gpt-4o-mini': { inputPrice: 0.15, outputPrice: 0.6 },
  'openai/gpt-4-turbo': { inputPrice: 10, outputPrice: 30 },

  // Anthropic (via gateway)
  'anthropic/claude-opus-4.8': { inputPrice: 3, outputPrice: 15 },
  'anthropic/claude-sonnet-4': { inputPrice: 3, outputPrice: 15 },
  'anthropic/claude-haiku-4.5': { inputPrice: 0.8, outputPrice: 4 },

  // Google (via gateway)
  'google/gemini-2.5-pro': { inputPrice: 1.25, outputPrice: 5 },
  'google/gemini-2.5-flash': { inputPrice: 0.075, outputPrice: 0.3 },
  'google/gemini-2.5-flash-lite': { inputPrice: 0.075, outputPrice: 0.3 },

  // Budget / cheap hosted models (verified 2026-09, $/1M tokens)
  'amazon/nova-micro': { inputPrice: 0.035, outputPrice: 0.14 },
  'alibaba/qwen3.7-flash': { inputPrice: 0.03, outputPrice: 0.13 },
  'alibaba/qwen3-coder-30b-a3b': { inputPrice: 0.15, outputPrice: 0.6 },
  'deepseek/deepseek-v4-flash-0731': { inputPrice: 0.076, outputPrice: 0.153 },
  'inclusionai/ling-3.0-flash': { inputPrice: 0.021, outputPrice: 0.063 },
  // Known published free-tier rates: a known static estimate of $0 (not unknown).
  'inclusionai/ling-3.0-flash-vl-free': { inputPrice: 0, outputPrice: 0 },
  'poolside/laguna-s-2.1-free': { inputPrice: 0, outputPrice: 0 },
};

/** A model whose cost cannot be priced statically (unknown id, or a dynamic router). */
const DYNAMIC_MODELS = new Set<string>(['openrouter/auto']);

export type CostProvider = 'gateway' | 'openrouter' | 'local';

/** 'estimated' = derived from the dated static table; 'unknown' = no static price. */
export type CostStatus = 'estimated' | 'unknown';

/** Where an estimate came from. 'none' means no source → cost is unknown. */
export type CostSource = 'static-price-table' | 'none';

export interface CostEstimate {
  model: string;
  provider: CostProvider;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD from the dated static table. NOT actual billed cost. `null` = unknown. */
  estimatedUSD: number | null;
  /** Estimated input-side USD, or `null` when unknown. */
  inputCostUSD: number | null;
  /** Estimated output-side USD, or `null` when unknown. */
  outputCostUSD: number | null;
  status: CostStatus;
  source: CostSource;
  /** Human-readable provenance / why the cost is unknown. Always non-empty. */
  note: string;
}

export function estimateCost(
  model: string,
  provider: CostProvider,
  inputTokens: number,
  outputTokens: number,
): CostEstimate {
  const base = { model, provider, inputTokens, outputTokens };
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    return {
      ...base,
      estimatedUSD: null,
      inputCostUSD: null,
      outputCostUSD: null,
      status: 'unknown',
      source: 'none',
      note: 'Missing or invalid token usage; a cost estimate cannot be computed.',
    };
  }

  if (DYNAMIC_MODELS.has(model)) {
    return {
      ...base,
      estimatedUSD: null,
      inputCostUSD: null,
      outputCostUSD: null,
      status: 'unknown',
      source: 'none',
      note: `OpenRouter Auto selects the model per request, so there is no static price; the selected model's rate is unknown until it is reconciled after generation. Not a billable figure.`,
    };
  }

  if (provider === 'local') {
    return {
      ...base,
      estimatedUSD: null,
      inputCostUSD: null,
      outputCostUSD: null,
      status: 'unknown',
      source: 'none',
      note: 'Local compute is not billed through the provider API, but it is not zero cost (hardware, energy and opportunity costs are unmeasured here). Cost unknown.',
    };
  }

  const pricing = PRICING[model];
  if (!pricing) {
    return {
      ...base,
      estimatedUSD: null,
      inputCostUSD: null,
      outputCostUSD: null,
      status: 'unknown',
      source: 'none',
      note: `No static price for '${model}' in the ${PRICING_DATE} table. Cost unknown — not zero and not free.`,
    };
  }

  const inputCostUSD = (inputTokens / 1_000_000) * pricing.inputPrice;
  const outputCostUSD = (outputTokens / 1_000_000) * pricing.outputPrice;
  const estimatedUSD = inputCostUSD + outputCostUSD;

  return {
    ...base,
    estimatedUSD,
    inputCostUSD,
    outputCostUSD,
    status: 'estimated',
    source: 'static-price-table',
    note: `Estimated from the ${PRICING_DATE} static price table; an estimate only — never actual cost.`,
  };
}

/** Display token for an estimate. Unknown is rendered as `unknown`, never `(free)`. */
export function formatCost(cost: CostEstimate): string {
  if (cost.estimatedUSD === null) return 'unknown';
  if (cost.estimatedUSD === 0) {
    const prices = PRICING[cost.model];
    return prices?.inputPrice === 0 && prices.outputPrice === 0
      ? '~$0.0000 (free tier rate in dated table)'
      : '~$0.0000 (zero measured tokens)';
  }
  if (cost.estimatedUSD < 0.0001) return `~$${cost.estimatedUSD.toExponential(2)}`;
  return `~$${cost.estimatedUSD.toFixed(4)}`;
}
