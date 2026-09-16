/**
 * Task-type model router — hybrid across the Vercel AI Gateway and OpenRouter.
 *
 * Pattern: classify the request in code -> select a provider + model per tier.
 *   - fast tier   -> OpenRouter's `openrouter/auto` (OpenRouter picks the model)
 *   - other tiers -> Vercel AI Gateway with an explicit model ID + fallback chain
 *
 * All model IDs below are VERIFIED against the live catalogs
 * (ai-gateway.vercel.sh/v1/models and openrouter.ai/api/v1/models).
 *
 * Env: AI_GATEWAY_API_KEY (gateway tiers) and OPENROUTER_API_KEY (fast tier).
 */

import { generateText } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { classifySemantic } from './semantic-classifier';

/** Lazily construct the OpenRouter provider so the API key is read at call time,
 *  not at module load (ESM import hoisting would otherwise beat dotenv setup). */
let _openrouter: ReturnType<typeof createOpenRouter> | null = null;
function openrouterProvider() {
  if (!_openrouter) {
    _openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY ?? '' });
  }
  return _openrouter;
}

/** Lazily construct the local (OpenAI-compatible) provider — e.g. a llama.cpp / LM Studio
 *  server hosting Qwen. Free + private; used for the `fast` tier when selected.
 *  Configure with LOCAL_LLM_BASE_URL (…/v1), LOCAL_LLM_API_KEY, LOCAL_LLM_MODEL. */
let _local: ReturnType<typeof createOpenAICompatible> | null = null;
function localProvider() {
  if (!_local) {
    _local = createOpenAICompatible({
      name: 'local',
      baseURL: process.env.LOCAL_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1',
      apiKey: process.env.LOCAL_LLM_API_KEY ?? 'local',
    });
  }
  return _local;
}
const LOCAL_FAST_MODEL = () => process.env.LOCAL_LLM_MODEL ?? 'local-model';

/**
 * The `fast` tier can be served three ways (see FAST_TIER toggle below):
 *   - 'openrouter' → OpenRouter's Auto Router (`openrouter/auto`) picks the model per request.
 *   - 'gateway'    → the Vercel gateway with an explicit `fast` model ID + fallback chain.
 *   - 'local'      → a local OpenAI-compatible server (e.g. Qwen via llama.cpp): free + private.
 */
const OPENROUTER_FAST_MODEL = 'openrouter/auto';

export type TaskTier = 'fast' | 'reasoning' | 'vision' | 'coding';

/** Which backend serves the `fast` tier. */
export type FastTierProvider = 'openrouter' | 'gateway' | 'local';

/**
 * Fast-tier routing toggle — controllable by human or machine.
 *
 * Precedence (highest first):
 *   1. per-call override:  routedGenerate({ ..., fastProvider: 'gateway' })
 *   2. programmatic default: setFastTierProvider('gateway')  ← machine/agent control
 *   3. environment:        FAST_TIER_PROVIDER=gateway|openrouter|local  ← human/ops control
 *   4. built-in default:   'openrouter'
 */
const DEFAULT_FAST_TIER_PROVIDER: FastTierProvider = 'openrouter';
let _fastTierOverride: FastTierProvider | null = null;

function envFastTierProvider(): FastTierProvider | null {
  const v = process.env.FAST_TIER_PROVIDER?.trim().toLowerCase();
  return v === 'gateway' || v === 'openrouter' || v === 'local' ? v : null;
}

/** Programmatically set the fast-tier backend (persists until reset). Pass null to clear. */
export function setFastTierProvider(provider: FastTierProvider | null): void {
  _fastTierOverride = provider;
}

/** The effective fast-tier backend given an optional per-call override. */
export function fastTierProvider(perCall?: FastTierProvider): FastTierProvider {
  return perCall ?? _fastTierOverride ?? envFastTierProvider() ?? DEFAULT_FAST_TIER_PROVIDER;
}

/** Primary model per tier. VERIFY these against the catalog before production use. */
export const TIER_MODELS: Record<TaskTier, string> = {
  fast: 'openai/gpt-4o-mini',
  reasoning: 'anthropic/claude-opus-4.8',
  vision: 'openai/gpt-4o',
  coding: 'anthropic/claude-sonnet-4',
};

/** Fallback chain per tier — the gateway tries these in order if the primary fails. */
export const TIER_FALLBACKS: Record<TaskTier, string[]> = {
  fast: ['google/gemini-2.5-flash-lite'],
  reasoning: ['openai/o3', 'google/gemini-2.5-pro'],
  vision: ['google/gemini-2.5-flash'],
  coding: ['openai/gpt-4o'],
};

export interface RouteInput {
  prompt: string;
  /**
   * Image inputs for the vision tier. Each entry is anything the AI SDK accepts
   * as image content: a URL, a data URL, a base64 string, or raw bytes
   * (Uint8Array/Buffer/ArrayBuffer). Presence also drives classification.
   */
  images?: Array<string | URL | Uint8Array | ArrayBuffer>;
  /** @deprecated Set `images` instead; kept for back-compat with the classifier. */
  hasImages?: boolean;
  /** Bypass the classifier and force a tier. */
  forceTier?: TaskTier;
  /** Per-call override of the fast-tier backend (highest precedence). */
  fastProvider?: FastTierProvider;
}

const CODE_RE = /```|\b(function|def|class|import|const|SELECT|=>|public\s+static)\b/;
const REASON_RE =
  /\b(prove|analy[sz]e|reason|derive|step[- ]by[- ]step|explain why|trade[- ]?offs?|architect|strategy)\b/i;

/** Decide the tier for a request. Cheapest tier that satisfies the request wins. */
export function classify(input: RouteInput): TaskTier {
  if (input.forceTier) return input.forceTier;
  if (input.hasImages || (input.images?.length ?? 0) > 0) return 'vision';
  if (CODE_RE.test(input.prompt)) return 'coding';
  if (REASON_RE.test(input.prompt) || input.prompt.length > 1500) return 'reasoning';
  return 'fast';
}

/** Resolve a classified request to an AI SDK model + provider options.
 *  fast -> OpenRouter Auto Router OR the gateway (per the FAST_TIER toggle);
 *  all other tiers -> Vercel AI Gateway. */
export function modelForInput(input: RouteInput) {
  return buildRoute(classify(input), input);
}

/** How the tier is decided. 'auto' = semantic when an embeddings key is present, else regex. */
export type ClassifierMode = 'regex' | 'semantic' | 'auto';

function classifierMode(): ClassifierMode {
  const v = process.env.CLASSIFIER?.trim().toLowerCase();
  return v === 'regex' || v === 'semantic' || v === 'auto' ? v : 'auto';
}

/**
 * Async classification honoring CLASSIFIER (default 'auto').
 * Uses the embeddings classifier when selected/available, and transparently
 * falls back to the regex classifier if embeddings error out (no key, network, etc.).
 */
export async function classifyAsync(
  input: RouteInput,
): Promise<{ tier: TaskTier; method: 'regex' | 'semantic' }> {
  const mode = classifierMode();
  const useSemantic = mode === 'semantic' || (mode === 'auto' && !!process.env.AI_GATEWAY_API_KEY);
  if (useSemantic) {
    try {
      return { tier: await classifySemantic(input), method: 'semantic' };
    } catch {
      // fall through to the resilient regex path
    }
  }
  return { tier: classify(input), method: 'regex' };
}

/** Build the model + provider options for an already-decided tier. */
function buildRoute(tier: TaskTier, input: RouteInput) {
  if (tier === 'fast') {
    const fp = fastTierProvider(input.fastProvider);
    if (fp === 'openrouter') {
      return {
        tier,
        provider: 'openrouter' as const,
        // OpenRouter's Auto Router selects the concrete model per request.
        model: openrouterProvider()(OPENROUTER_FAST_MODEL),
        // No gateway providerOptions on this path — routing is OpenRouter-side.
        providerOptions: undefined,
      };
    }
    if (fp === 'local') {
      return {
        tier,
        provider: 'local' as const,
        // Local OpenAI-compatible server (e.g. Qwen via llama.cpp): free + private.
        model: localProvider()(LOCAL_FAST_MODEL()),
        providerOptions: undefined,
      };
    }
    // fp === 'gateway' falls through to the gateway path below.
  }

  // All gateway-served tiers, including fast when the toggle selects 'gateway'.
  return {
    tier,
    provider: 'gateway' as const,
    model: gateway(TIER_MODELS[tier]),
    providerOptions: {
      gateway: {
        // Automatic model-level fallback if the primary is unavailable.
        models: TIER_FALLBACKS[tier],
      },
    },
  };
}

/** Resolve using the configured classifier (semantic by default; see CLASSIFIER env). */
export async function modelForInputAsync(input: RouteInput) {
  const { tier, method } = await classifyAsync(input);
  return { ...buildRoute(tier, input), method };
}

/** End-to-end: classify -> route -> generate. Sends images as a multimodal message when present.
 *  Uses the configured classifier (semantic by default) with regex fallback. */
export async function routedGenerate(input: RouteInput) {
  const { tier, provider, method, model, providerOptions } = await modelForInputAsync(input);
  const images = input.images ?? [];
  const res = await generateText({
    model,
    ...(providerOptions ? { providerOptions } : {}),
    ...(images.length > 0
      ? {
          messages: [
            {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: input.prompt },
                ...images.map((image) => ({ type: 'image' as const, image })),
              ],
            },
          ],
        }
      : { prompt: input.prompt }),
  });
  return { tier, provider, method, text: res.text, usage: res.usage };
}
