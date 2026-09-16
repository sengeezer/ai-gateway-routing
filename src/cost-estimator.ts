/**
 * Cost estimation for LLM calls.
 * Pricing as of 2026-09 (Vercel AI Gateway published rates; see https://vercel.com/docs/ai-gateway).
 * USD per 1M tokens.
 */

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

  // OpenRouter
  'openrouter/auto': { inputPrice: 2, outputPrice: 6 }, // conservative estimate
};

export interface CostEstimate {
  model: string;
  provider: 'gateway' | 'openrouter' | 'local';
  inputTokens: number;
  outputTokens: number;
  estimatedUSD: number;
  inputCostUSD: number;
  outputCostUSD: number;
}

export function estimateCost(
  model: string,
  provider: 'gateway' | 'openrouter' | 'local',
  inputTokens: number,
  outputTokens: number,
): CostEstimate {
  if (provider === 'local') {
    // local inference is free
    return { model, provider, inputTokens, outputTokens, estimatedUSD: 0, inputCostUSD: 0, outputCostUSD: 0 };
  }

  const pricing = PRICING[model];
  if (!pricing) {
    // fallback: assume mid-tier (e.g., unknown OpenRouter model)
    return {
      model,
      provider,
      inputTokens,
      outputTokens,
      estimatedUSD: 0,
      inputCostUSD: 0,
      outputCostUSD: 0,
    };
  }

  const inputCostUSD = (inputTokens / 1_000_000) * pricing.inputPrice;
  const outputCostUSD = (outputTokens / 1_000_000) * pricing.outputPrice;
  const estimatedUSD = inputCostUSD + outputCostUSD;

  return { model, provider, inputTokens, outputTokens, estimatedUSD, inputCostUSD, outputCostUSD };
}

export function formatCost(cost: CostEstimate): string {
  if (cost.estimatedUSD === 0) return '(free)';
  if (cost.estimatedUSD < 0.0001) return `~$${cost.estimatedUSD.toExponential(2)}`;
  return `~$${cost.estimatedUSD.toFixed(4)}`;
}
