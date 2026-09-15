import type { VercelRequest, VercelResponse } from '@vercel/node';
import { modelForInput, TIER_MODELS, type RouteInput, type FastTierProvider } from '../src/router';

/**
 * POST /api/classify  (also GET /api/classify?prompt=...)
 *
 * Pure classification — NO model call, so it costs nothing and is safe to expose.
 * Returns the tier the request would route to, the backend provider, and the
 * concrete model (for gateway tiers) or 'openrouter/auto' (for the OpenRouter fast tier).
 *
 * Body / query:
 *   prompt       string (required)
 *   hasImages    boolean (optional)  — force the vision signal
 *   forceTier    'fast'|'reasoning'|'vision'|'coding' (optional)
 *   fastProvider 'openrouter'|'gateway' (optional) — override the fast-tier backend
 */
export default function handler(req: VercelRequest, res: VercelResponse) {
  const src = req.method === 'GET' ? req.query : (req.body ?? {});

  const prompt = typeof src.prompt === 'string' ? src.prompt : undefined;
  if (!prompt) {
    res.status(400).json({ error: "missing 'prompt'" });
    return;
  }

  const input: RouteInput = {
    prompt,
    hasImages: src.hasImages === true || src.hasImages === 'true',
    forceTier: typeof src.forceTier === 'string' ? (src.forceTier as RouteInput['forceTier']) : undefined,
    fastProvider:
      src.fastProvider === 'openrouter' || src.fastProvider === 'gateway'
        ? (src.fastProvider as FastTierProvider)
        : undefined,
  };

  const { tier, provider } = modelForInput(input);
  const model = provider === 'openrouter' ? 'openrouter/auto' : TIER_MODELS[tier];

  res.status(200).json({ tier, provider, model });
}
