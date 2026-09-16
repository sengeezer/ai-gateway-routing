import { modelForInput, TIER_MODELS, type RouteInput, type FastTierProvider } from '../src/router';

/**
 * GET/POST /api/classify  — Vercel Function (Web handler; no @vercel/node dependency).
 *
 * Pure classification — NO model call, so it costs nothing and is safe to expose.
 * Uses the synchronous regex classifier (free/offline). Returns the tier the request
 * would route to, the backend provider, and the concrete model (or 'openrouter/auto').
 *
 * Body (POST JSON) or query (GET):
 *   prompt       string (required)
 *   hasImages    boolean|'true' (optional)
 *   forceTier    'fast'|'reasoning'|'vision'|'coding' (optional)
 *   fastProvider 'openrouter'|'gateway' (optional)
 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default async function handler(request: Request): Promise<Response> {
  let src: Record<string, unknown> = {};
  if (request.method === 'GET') {
    src = Object.fromEntries(new URL(request.url).searchParams.entries());
  } else {
    try {
      src = (await request.json()) as Record<string, unknown>;
    } catch {
      src = {};
    }
  }

  const prompt = typeof src.prompt === 'string' ? src.prompt : undefined;
  if (!prompt) return json({ error: "missing 'prompt'" }, 400);

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
  return json({ tier, provider, model });
}
