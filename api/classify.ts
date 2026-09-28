import { modelForInput, type RouteInput, type TaskTier, type FastTierProvider } from '../src/router';

/**
 * GET/POST /api/classify  — Vercel Function (Web handler; no @vercel/node dependency).
 *
 * Pure classification — NO model call and NO network, so it incurs no model fee.
 * Authentication and rate limiting are NOT provided here; do not expose it without
 * appropriate deployment protections. Uses the synchronous regex classifier.
 * Returns the selected tier, backend provider and model ID (or the dynamic
 * `openrouter/auto` alias). For gateway routes this is the requested primary,
 * NOT the provider's executed model after a possible fallback. It follows the
 * active TIER_PROFILE, FAST_TIER_PROVIDER and local fast model settings.
 *
 * Body (POST JSON object) or query (GET):
 *   prompt       string (required, max 10_000 chars)
 *   hasImages    boolean|'true' (optional)
 *   forceTier    'fast'|'reasoning'|'vision'|'coding' (optional; other values → 400)
 *   fastProvider 'openrouter'|'gateway'|'local' (optional; other values → 400)
 *
 * Rejected inputs: images field (unvalidated URLs must not enter the pipeline — pass
 * `hasImages` instead), unsupported methods (405), malformed/non-object JSON body
 * (400), oversized prompt (413).
 */
const MAX_PROMPT_CHARS = 10_000;

const VALID_TIERS: readonly TaskTier[] = ['fast', 'reasoning', 'vision', 'coding'];
const VALID_FAST_PROVIDERS: readonly FastTierProvider[] = ['openrouter', 'gateway', 'local'];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default async function handler(request: Request): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    return json({ error: `method ${request.method} not allowed; use GET or POST` }, 405);
  }

  let src: unknown;
  if (method === 'GET') {
    src = Object.fromEntries(new URL(request.url).searchParams.entries());
  } else {
    try {
      src = JSON.parse(await request.text());
    } catch {
      return json({ error: 'request body must be valid JSON' }, 400);
    }
    if (src === null || typeof src !== 'object' || Array.isArray(src)) {
      return json({ error: 'request body must be a JSON object' }, 400);
    }
  }

  const body = src as Record<string, unknown>;
  const prompt = typeof body.prompt === 'string' ? body.prompt : undefined;
  if (!prompt) return json({ error: "missing 'prompt'" }, 400);
  if (prompt.length > MAX_PROMPT_CHARS) {
    return json(
      { error: `prompt exceeds ${MAX_PROMPT_CHARS} characters` },
      413,
    );
  }

  // This endpoint never accepts image URLs: it cannot validate them, and passing them
  // through would misroute unvalidated input downstream. Point callers at hasImages.
  if (body.images !== undefined) {
    return json(
      { error: "this endpoint does not accept 'images'; pass hasImages instead" },
      400,
    );
  }

  const forceTier = body.forceTier;
  if (forceTier !== undefined && (typeof forceTier !== 'string' || !VALID_TIERS.includes(forceTier as TaskTier))) {
    return json({ error: `invalid forceTier; expected one of ${VALID_TIERS.join('|')}` }, 400);
  }

  const fastProvider = body.fastProvider;
  if (fastProvider !== undefined && (typeof fastProvider !== 'string' || !VALID_FAST_PROVIDERS.includes(fastProvider as FastTierProvider))) {
    return json({ error: `invalid fastProvider; expected one of ${VALID_FAST_PROVIDERS.join('|')}` }, 400);
  }

  if (body.hasImages !== undefined && body.hasImages !== true && body.hasImages !== false && body.hasImages !== 'true' && body.hasImages !== 'false') {
    return json({ error: 'invalid hasImages; expected true or false' }, 400);
  }

  const input: RouteInput = {
    prompt,
    hasImages: body.hasImages === true || body.hasImages === 'true',
    ...(forceTier !== undefined ? { forceTier: forceTier as TaskTier } : {}),
    ...(fastProvider !== undefined ? { fastProvider: fastProvider as FastTierProvider } : {}),
  };

  const route = modelForInput(input);
  // Prefer the actually routed model ID over a duplicate tier→model map: it honors
  // TIER_PROFILE (budget/quality), the FAST_TIER_PROVIDER toggle, and the local model.
  const model = route.model.modelId;
  return json({ tier: route.tier, provider: route.provider, model });
}