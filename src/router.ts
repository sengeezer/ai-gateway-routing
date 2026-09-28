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
import type { CostEstimate } from './cost-estimator';
import {
  buildGenerationRecord,
  buildPolicy,
  consoleTelemetrySink,
  describeClassifier,
  extractServedIdentity,
  newRequestId,
  resolveGenerationCost,
  sanitizeError,
  type GenerateTextFn,
  type GenerateTextResultLike,
  type GenerationTelemetrySink,
} from './generation-telemetry';

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
 *  server hosting Qwen. Opt-in only; API-unbilled, but compute costs are unmeasured.
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
 *   - 'local'      → an opt-in local OpenAI-compatible server; API-unbilled, but compute cost is not zero.
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

/**
 * Tier profile selects which model map to use:
 *   - 'quality' (default): the premium models above (quality-first).
 *   - 'budget': cheap/free models hosted ON the gateway (Qwen-centric) — zero local
 *     compute, so nothing runs on your machine. Flip with `TIER_PROFILE=budget`.
 * All budget IDs are verified live on the gateway. Prices are $/1M tokens (in/out),
 * as of 2026-09; compare to quality (e.g. reasoning opus $3/$15, vision gpt-4o $5/$15).
 */
export type TierProfile = 'quality' | 'budget';

export function tierProfile(): TierProfile {
  return process.env.TIER_PROFILE?.trim().toLowerCase() === 'budget' ? 'budget' : 'quality';
}

/** Cheap/free hosted models (verified live). Qwen-centric; no machine load. */
export const BUDGET_TIER_MODELS: Record<TaskTier, string> = {
  fast: 'amazon/nova-micro', //            $0.035/$0.14 — concise, fast (non-thinking)
  reasoning: 'alibaba/qwen3.7-flash', //   $0.03/$0.13  — hosted Qwen (thinking), 991k ctx
  vision: 'alibaba/qwen3.7-flash', //      $0.03/$0.13  — hosted Qwen vision, 991k ctx
  coding: 'alibaba/qwen3-coder-30b-a3b', //$0.15/$0.60  — Qwen coder, 262k ctx
};

export const BUDGET_TIER_FALLBACKS: Record<TaskTier, string[]> = {
  fast: ['google/gemini-2.5-flash-lite', 'inclusionai/ling-3.0-flash'],
  reasoning: ['deepseek/deepseek-v4-flash-0731', 'google/gemini-2.5-flash'],
  vision: ['inclusionai/ling-3.0-flash-vl-free', 'google/gemini-2.5-flash'], // free vision fallback
  coding: ['deepseek/deepseek-v4-flash-0731', 'openai/gpt-4o-mini'],
};

/** The model map / fallback chain for the active TIER_PROFILE. */
export function activeTierModels(): Record<TaskTier, string> {
  return tierProfile() === 'budget' ? BUDGET_TIER_MODELS : TIER_MODELS;
}
export function activeTierFallbacks(): Record<TaskTier, string[]> {
  return tierProfile() === 'budget' ? BUDGET_TIER_FALLBACKS : TIER_FALLBACKS;
}

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

export interface GenerateOutput {
  tier: TaskTier;
  provider: 'gateway' | 'openrouter' | 'local';
  method: 'semantic' | 'regex';
  text: string;
  usage: any; // LanguageModelV2Usage
  cost: CostEstimate;
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
 * Whether an embeddings (semantic) classification attempt is planned for a
 * classifier mode. Exported so the telemetry can report `requested` vs.
 * `effective` vs. `fallback` without guessing, and so tests cover it offline.
 */
export function semanticPlanned(mode: ClassifierMode, hasGatewayKey: boolean): boolean {
  return mode === 'semantic' || (mode === 'auto' && hasGatewayKey);
}

/**
 * Async classification honoring CLASSIFIER (default 'auto').
 * Uses the embeddings classifier when selected/available, and transparently
 * falls back to the regex classifier if embeddings error out (no key, network, etc).
 */
export async function classifyAsync(
  input: RouteInput,
): Promise<{ tier: TaskTier; method: 'regex' | 'semantic' }> {
  const mode = classifierMode();
  const useSemantic = semanticPlanned(mode, !!process.env.AI_GATEWAY_API_KEY);
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
        // Usage accounting is requested (documented by the installed provider:
        // `usage: { include: true }`) so the response carries an in-band billed
        // `providerMetadata.openrouter.usage.cost` for the baseline telemetry.
        model: openrouterProvider()(OPENROUTER_FAST_MODEL, { usage: { include: true } }),
        // No gateway providerOptions on this path — routing is OpenRouter-side.
        providerOptions: undefined,
      };
    }
    if (fp === 'local') {
      return {
        tier,
        provider: 'local' as const,
        // Opt-in local server; no provider API bill, but compute overhead is unmeasured.
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
    model: gateway(activeTierModels()[tier]),
    providerOptions: {
      gateway: {
        // Automatic model-level fallback if the primary is unavailable.
        models: activeTierFallbacks()[tier],
      },
    },
  };
}

/** Resolve using the configured classifier (semantic by default; see CLASSIFIER env). */
export async function modelForInputAsync(input: RouteInput) {
  const { tier, method } = await classifyAsync(input);
  return { ...buildRoute(tier, input), method };
}

/**
 * Optional seams for `routedGenerate`. All default to production behavior; each
 * exists so the routing + telemetry path can be exercised fully offline.
 */
export interface RoutedGenerateDeps {
  /** Injected generator. Defaults to the AI SDK's `generateText`. */
  generateText?: GenerateTextFn;
  /**
   * Opt-in telemetry sink. Replaces the default metadata-only console line.
   * A sink that throws is swallowed: telemetry never fails a generation.
   */
  sink?: GenerationTelemetrySink;
  /** Clock injection for deterministic latency in tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Request-id factory injection for deterministic tests. Defaults to a UUID. */
  makeRequestId?: () => string;
}

function elapsedMs(end: number, start: number): number {
  const delta = end - start;
  return Number.isFinite(delta) && delta >= 0 ? delta : 0;
}

/**
 * End-to-end: classify -> route -> generate. Sends images as a multimodal message when present.
 *  Uses the configured classifier (semantic by default) with regex fallback.
 *
 * Phase-0 baseline: every call emits one privacy-safe telemetry record (request id,
 * policy descriptor, classifier requested/effective/fallback, selected vs. actually
 * served provider/model + generation id, fallback attempts, usage, wall latency and a
 * cost kind of actual/estimated/unknown). The record never carries prompt text, model
 * output, headers or keys, and the sink or provider metadata can never break a call.
 *
 * `cost` on the returned object remains the STATIC estimate for the model that
 * actually served the request when that is known (unknown after an unresolved
 * fallback) — the billed figure, when one is available in band, lives in the
 * telemetry record's `cost` field. Generation lookup over REST is deferred.
 */
export async function routedGenerate(
  input: RouteInput,
  deps: RoutedGenerateDeps = {},
): Promise<GenerateOutput> {
  const generate = (deps.generateText ?? generateText) as unknown as GenerateTextFn;
  const now = deps.now ?? (() => Date.now());
  const sink = deps.sink ?? consoleTelemetrySink;
  const requestId = (deps.makeRequestId ?? newRequestId)();

  const mode = classifierMode();
  const { tier, provider, method, model, providerOptions } = await modelForInputAsync(input);

  const classifier = describeClassifier({
    requested: mode,
    semanticPlanned: semanticPlanned(mode, !!process.env.AI_GATEWAY_API_KEY),
    effective: method,
    tier,
  });
  const policy = buildPolicy({
    profile: tierProfile(),
    models: activeTierModels(),
    fallbacks: activeTierFallbacks(),
    fastTierDefault: DEFAULT_FAST_TIER_PROVIDER,
  });
  const selected = { provider, model: model.modelId };

  const emit: GenerationTelemetrySink = (record) => {
    try {
      sink(record);
    } catch {
      // A broken sink (or metadata callback) must never fail the generation.
    }
  };

  const startedAt = now();
  const images = input.images ?? [];

  let res: GenerateTextResultLike;
  try {
    res = await generate({
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
  } catch (error) {
    // Sanitized failure record (class name + HTTP status only), then rethrow
    // the ORIGINAL error so callers keep the existing failure behavior.
    emit(
      buildGenerationRecord({
        requestId,
        policy,
        classifier,
        selected,
        identity: extractServedIdentity({
          selectedProvider: provider,
          selectedModel: model.modelId,
        }),
        latencyMs: elapsedMs(now(), startedAt),
        tokens: null,
        status: 'error',
        error: sanitizeError(error),
        failureStage: 'generation',
      }),
    );
    throw error;
  }

  const latencyMs = elapsedMs(now(), startedAt);
  const identity = extractServedIdentity({
    selectedProvider: provider,
    selectedModel: model.modelId,
    response: res.response,
    providerMetadata: res.providerMetadata,
  });
  const { estimate: cost } = resolveGenerationCost({
    provider,
    selectedModel: model.modelId,
    served: identity.served,
    tokens: {
      inputTokens: res.usage?.inputTokens ?? 0,
      outputTokens: res.usage?.outputTokens ?? 0,
    },
    billedUSD: identity.billedUSD,
    billedSource: identity.billedSource,
  });

  emit(
    buildGenerationRecord({
      requestId,
      policy,
      classifier,
      selected,
      identity,
      latencyMs,
      tokens: {
        inputTokens: res.usage?.inputTokens ?? null,
        outputTokens: res.usage?.outputTokens ?? null,
        totalTokens: res.usage?.totalTokens ?? null,
      },
    }),
  );

  return { tier, provider, method, text: res.text, usage: res.usage, cost };
}
