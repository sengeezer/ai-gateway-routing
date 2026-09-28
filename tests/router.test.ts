import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classify,
  classifyAsync,
  fastTierProvider,
  modelForInput,
  routedGenerate,
  semanticPlanned,
  type RoutedGenerateDeps,
  setFastTierProvider,
  tierProfile,
  activeTierModels,
  activeTierFallbacks,
  TIER_MODELS,
  BUDGET_TIER_MODELS,
  type RouteInput,
} from '../src/router';
import type { GenerationTelemetryRecord } from '../src/generation-telemetry';

// Fail-closed network guard: no test in this file may reach a provider. If the
// injectable generator seam ever regresses, the test fails loudly here instead
// of making an unauthenticated (or worse, billable) external call.
beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('TEST_NETWORK_BLOCKED: a test attempted an external HTTP call');
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('classify', () => {
  it('honors forceTier over every other signal', () => {
    expect(classify({ prompt: 'hi', forceTier: 'coding' })).toBe('coding');
    expect(classify({ prompt: 'const x = 1', hasImages: true, forceTier: 'fast' })).toBe('fast');
  });

  it('routes images to vision (via hasImages or images[])', () => {
    expect(classify({ prompt: 'what is this?', hasImages: true })).toBe('vision');
    expect(classify({ prompt: 'what is this?', images: ['https://x/y.png'] })).toBe('vision');
  });

  it('vision wins over code signals when an image is present', () => {
    expect(classify({ prompt: 'why does this class fail to import?', hasImages: true })).toBe('vision');
  });

  it('detects code by fence or code tokens', () => {
    expect(classify({ prompt: '```py\nprint(1)\n```' })).toBe('coding');
    expect(classify({ prompt: 'function add(a,b){return a+b}' })).toBe('coding');
    expect(classify({ prompt: 'SELECT * FROM users' })).toBe('coding');
  });

  it('detects reasoning by keyword or long length', () => {
    expect(classify({ prompt: 'Analyze the trade-offs step by step.' })).toBe('reasoning');
    expect(classify({ prompt: 'x'.repeat(1600) })).toBe('reasoning');
  });

  it('falls back to fast for short simple text', () => {
    expect(classify({ prompt: 'Capital of France?' })).toBe('fast');
  });
});

describe('fast-tier toggle precedence', () => {
  beforeEach(() => {
    setFastTierProvider(null);
    delete process.env.FAST_TIER_PROVIDER;
  });
  afterEach(() => {
    setFastTierProvider(null);
    delete process.env.FAST_TIER_PROVIDER;
  });

  it('defaults to openrouter', () => {
    expect(fastTierProvider()).toBe('openrouter');
  });

  it('env overrides the default', () => {
    process.env.FAST_TIER_PROVIDER = 'gateway';
    expect(fastTierProvider()).toBe('gateway');
  });

  it('programmatic setter overrides env', () => {
    process.env.FAST_TIER_PROVIDER = 'gateway';
    setFastTierProvider('openrouter');
    expect(fastTierProvider()).toBe('openrouter');
  });

  it('per-call override beats setter and env', () => {
    process.env.FAST_TIER_PROVIDER = 'gateway';
    setFastTierProvider('gateway');
    expect(fastTierProvider('openrouter')).toBe('openrouter');
  });

  it('supports the local provider via env and setter', () => {
    process.env.FAST_TIER_PROVIDER = 'local';
    expect(fastTierProvider()).toBe('local');
    setFastTierProvider('openrouter');
    expect(fastTierProvider()).toBe('openrouter');
    expect(fastTierProvider('local')).toBe('local');
  });

  it('ignores an invalid env value', () => {
    process.env.FAST_TIER_PROVIDER = 'nonsense';
    expect(fastTierProvider()).toBe('openrouter');
  });
});

describe('tier profile (quality vs budget)', () => {
  beforeEach(() => delete process.env.TIER_PROFILE);
  afterEach(() => delete process.env.TIER_PROFILE);

  it('defaults to quality (premium models)', () => {
    expect(tierProfile()).toBe('quality');
    expect(activeTierModels()).toBe(TIER_MODELS);
    expect(activeTierModels().vision).toBe('openai/gpt-4o');
  });

  it('switches to budget (cheap hosted models) via env', () => {
    process.env.TIER_PROFILE = 'budget';
    expect(tierProfile()).toBe('budget');
    expect(activeTierModels()).toBe(BUDGET_TIER_MODELS);
    // hosted Qwen for vision/reasoning/coding — no local compute
    expect(activeTierModels().vision).toBe('alibaba/qwen3.7-flash');
    expect(activeTierModels().reasoning).toBe('alibaba/qwen3.7-flash');
    expect(activeTierModels().coding).toBe('alibaba/qwen3-coder-30b-a3b');
    expect(activeTierFallbacks().vision).toContain('inclusionai/ling-3.0-flash-vl-free');
  });
});

describe('modelForInput provider selection', () => {
  afterEach(() => {
    setFastTierProvider(null);
    delete process.env.FAST_TIER_PROVIDER;
  });

  it('fast -> openrouter by default', () => {
    const r = modelForInput({ prompt: 'hello' });
    expect(r.tier).toBe('fast');
    expect(r.provider).toBe('openrouter');
    expect(r.providerOptions).toBeUndefined();
  });

  it('fast -> gateway when toggled', () => {
    setFastTierProvider('gateway');
    const r = modelForInput({ prompt: 'hello' });
    expect(r.tier).toBe('fast');
    expect(r.provider).toBe('gateway');
    expect(r.providerOptions).toBeDefined();
  });

  it.each(['reasoning', 'coding'] as const)('%s -> gateway with a fallback chain', (kind) => {
    const input: RouteInput =
      kind === 'reasoning'
        ? { prompt: 'Analyze this step by step and reason carefully.' }
        : { prompt: '```py\nx=1\n```' };
    const r = modelForInput(input);
    expect(r.provider).toBe('gateway');
    expect(r.providerOptions?.gateway.models.length).toBeGreaterThan(0);
  });

  it('vision -> gateway', () => {
    const r = modelForInput({ prompt: 'what is this?', hasImages: true });
    expect(r.tier).toBe('vision');
    expect(r.provider).toBe('gateway');
  });
});

describe('classifyAsync (offline paths)', () => {
  const origKey = process.env.AI_GATEWAY_API_KEY;
  afterEach(() => {
    delete process.env.CLASSIFIER;
    if (origKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = origKey;
  });

  it('CLASSIFIER=regex forces the regex method (no network)', async () => {
    process.env.CLASSIFIER = 'regex';
    const r = await classifyAsync({ prompt: '```py\nx=1\n```' });
    expect(r.method).toBe('regex');
    expect(r.tier).toBe('coding');
  });

  it("auto mode without an embeddings key falls back to regex", async () => {
    process.env.CLASSIFIER = 'auto';
    delete process.env.AI_GATEWAY_API_KEY;
    const r = await classifyAsync({ prompt: 'Capital of France?' });
    expect(r.method).toBe('regex');
    expect(r.tier).toBe('fast');
  });

  it('honors forceTier regardless of method', async () => {
    process.env.CLASSIFIER = 'regex';
    const r = await classifyAsync({ prompt: 'x', forceTier: 'vision' });
    expect(r.tier).toBe('vision');
  });
});

describe('semanticPlanned', () => {
  it('plans embeddings only for semantic mode or auto-with-a-key', () => {
    expect(semanticPlanned('regex', true)).toBe(false);
    expect(semanticPlanned('regex', false)).toBe(false);
    expect(semanticPlanned('semantic', false)).toBe(true);
    expect(semanticPlanned('semantic', true)).toBe(true);
    expect(semanticPlanned('auto', false)).toBe(false);
    expect(semanticPlanned('auto', true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase-0 generation baseline telemetry — offline, injected generator + sink.
// No network: the injected generateText never talks to a provider.
// ---------------------------------------------------------------------------

const FAKE_USAGE = { inputTokens: 12, outputTokens: 34, totalTokens: 46 };

interface Harness {
  /** deps to hand routedGenerate: injected generator, capturing sink, fixed clock + id */
  deps: RoutedGenerateDeps;
  records: GenerationTelemetryRecord[];
  options: Array<Record<string, any>>;
}

const OR_RESULT = {
  text: 'Paris',
  usage: FAKE_USAGE,
  response: { id: 'gen-or-1', modelId: 'openai/gpt-4o-mini' },
  providerMetadata: { openrouter: { provider: 'OpenAI', usage: { cost: 0.0042 } } },
};

function harness(result: Record<string, unknown> = OR_RESULT): Harness {
  const records: GenerationTelemetryRecord[] = [];
  const options: Array<Record<string, any>> = [];
  let tick = 100;
  const deps: RoutedGenerateDeps = {
    generateText: (async (opts: Record<string, any>) => {
      options.push(opts);
      return result;
    }) as unknown as RoutedGenerateDeps['generateText'],
    sink: (r) => records.push(r),
    makeRequestId: () => '11111111-2222-4333-8444-555555555555',
    now: () => (tick += 5),
  };
  return { deps, records, options };
}

describe('routedGenerate telemetry (offline, injected)', () => {
  const origKey = process.env.AI_GATEWAY_API_KEY;
  beforeEach(() => {
    process.env.CLASSIFIER = 'regex';
    delete process.env.AI_GATEWAY_API_KEY;
    setFastTierProvider(null);
    delete process.env.FAST_TIER_PROVIDER;
    delete process.env.TIER_PROFILE;
  });
  afterEach(() => {
    delete process.env.CLASSIFIER;
    if (origKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = origKey;
    setFastTierProvider(null);
    delete process.env.FAST_TIER_PROVIDER;
    delete process.env.TIER_PROFILE;
    vi.restoreAllMocks();
  });

  it('preserves the existing routing + output fields and emits one baseline record', async () => {
    const h = harness();
    const out = await routedGenerate({ prompt: 'Capital of France?' }, h.deps);

    // unchanged public output contract
    expect(out.tier).toBe('fast');
    expect(out.provider).toBe('openrouter');
    expect(out.method).toBe('regex');
    expect(out.text).toBe('Paris');
    expect(out.usage).toBe(FAKE_USAGE);
    expect(out.cost.model).toBe('openai/gpt-4o-mini'); // priced on the served model
    expect(out.cost.status).toBe('estimated');

    // routing handed to the generator is untouched
    expect(h.options[0].model.modelId).toBe('openrouter/auto');
    expect(h.options[0].prompt).toBe('Capital of France?');

    expect(h.records).toHaveLength(1);
    const r = h.records[0];
    expect(r.requestId).toBe('11111111-2222-4333-8444-555555555555');
    expect(r.status).toBe('ok');
    expect(r.policy.id).toBe('tier-static-policy');
    expect(r.policy.descriptor).toMatch(/^[0-9a-f]{12}$/);
    expect(r.classifier).toEqual({
      requested: 'regex',
      semanticPlanned: false,
      effective: 'regex',
      fallback: false,
      tier: 'fast',
    });
    expect(r.selected).toEqual({ provider: 'openrouter', model: 'openrouter/auto' });
    expect(r.served.provider).toBe('OpenAI');
    expect(r.served.model).toBe('openai/gpt-4o-mini');
    expect(r.served.generationId).toBe('gen-or-1');
    expect(r.cost.kind).toBe('actual');
    expect(r.cost.actualUSD).toBeCloseTo(0.0042, 10);
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 34, totalTokens: 46 });
    expect(r.latencyMs).toBe(5);
    expect(r.fallbackAttempts).toEqual([]);
    expect(r.failures).toEqual([]);
    expect(r.error).toBeNull();
  });

  it('reports gateway fallback attempts separately from failures and never prices the alias', async () => {
    setFastTierProvider('gateway');
    const h = harness({
      text: 'ok',
      usage: FAKE_USAGE,
      response: { id: 'sdk-uuid-ignored', modelId: 'anthropic/claude-opus-4.8' },
      providerMetadata: {
        gateway: {
          generationId: 'gen_gw_7',
          cost: '0.0021',
          routing: {
            finalProvider: 'openai',
            modelAttempts: [
              { provider: 'anthropic', model: 'anthropic/claude-opus-4.8', status: 'error' },
              { provider: 'openai', model: 'openai/gpt-4o', status: 'success' },
            ],
          },
        },
      },
    });

    const out = await routedGenerate({ prompt: 'Analyze this step by step.', forceTier: 'reasoning' }, h.deps);
    expect(out.provider).toBe('gateway');
    expect(h.options[0].providerOptions.gateway.models.length).toBeGreaterThan(0);

    const r = h.records[0];
    expect(r.selected).toEqual({ provider: 'gateway', model: 'anthropic/claude-opus-4.8' });
    expect(r.served).toEqual({
      provider: 'openai',
      model: 'openai/gpt-4o',
      generationId: 'gen_gw_7',
      source: 'gateway-metadata',
      fallback: true,
    });
    expect(r.served.generationId).not.toBe('sdk-uuid-ignored');
    expect(r.fallbackAttempts).toEqual([
      { provider: 'anthropic', model: 'anthropic/claude-opus-4.8', status: 'failed' },
    ]);
    expect(r.failures).toEqual([]);
    expect(r.cost.kind).toBe('actual');
    expect(r.cost.actualUSD).toBeCloseTo(0.0021, 10);
  });

  it('leaves served identity + cost unknown when gateway metadata is absent (no fabrication)', async () => {
    setFastTierProvider('gateway');
    const h = harness({
      text: 'ok',
      usage: FAKE_USAGE,
      response: { id: 'sdk-uuid-not-authoritative', modelId: 'anthropic/claude-opus-4.8' },
    });

    await routedGenerate({ prompt: 'Analyze this step by step.', forceTier: 'reasoning' }, h.deps);
    const r = h.records[0];
    expect(r.served).toEqual({
      provider: null,
      model: null,
      generationId: null,
      source: 'none',
      fallback: false,
    });
    expect(r.cost.kind).toBe('estimated');
    expect(r.cost.estimatedForModel).toBe('anthropic/claude-opus-4.8');
    expect(r.cost.actualUSD).toBeNull();
  });

  it('never prices the selected model after an unattributed gateway fallback', async () => {
    setFastTierProvider('gateway');
    const h = harness({
      text: 'ok',
      usage: FAKE_USAGE,
      providerMetadata: {
        gateway: {
          generationId: 'gen_gw_8',
          routing: {
            finalProvider: 'google',
            modelAttempts: [
              { provider: 'anthropic', model: 'anthropic/claude-opus-4.8', status: 'error' },
              { provider: 'google' },
            ],
          },
        },
      },
    });

    const out = await routedGenerate(
      { prompt: 'Analyze this step by step.', forceTier: 'reasoning' },
      h.deps,
    );
    const r = h.records[0];
    expect(r.served.model).toBeNull(); // no winner attributable
    expect(r.served.provider).toBe('google');
    expect(r.served.fallback).toBe(true);
    expect(r.fallbackAttempts).toHaveLength(2);
    expect(r.cost.kind).toBe('unknown');
    expect(r.cost.estimatedUSD).toBeNull();
    // and the legacy output field is honest too: not priced on the selected model
    expect(out.cost.status).toBe('unknown');
    expect(out.cost.estimatedUSD).toBeNull();
  });

  it('requests OpenRouter usage accounting so billed cost is obtainable in band', () => {
    setFastTierProvider('openrouter');
    const r = modelForInput({ prompt: 'hello' });
    // documented by the installed provider (README "Usage Accounting");
    // without it providerMetadata.openrouter.usage.cost is absent.
    expect((r.model as unknown as { settings?: { usage?: { include?: boolean } } }).settings?.usage?.include).toBe(
      true,
    );
  });

  it('rethrows the original error and records a sanitized error status', async () => {
    const sentinel = 'SENTINEL_PROMPT_9f3c';
    const thrown = Object.assign(new Error(`upstream said no: ${sentinel}`), {
      name: 'APICallError',
      statusCode: 429,
    });
    const records: GenerationTelemetryRecord[] = [];
    const deps = {
      generateText: async () => {
        throw thrown;
      },
      sink: (r: GenerationTelemetryRecord) => records.push(r),
      makeRequestId: () => 'req-error',
      now: () => 0,
    };

    await expect(routedGenerate({ prompt: sentinel }, deps)).rejects.toBe(thrown);

    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.status).toBe('error');
    expect(r.error).toEqual({ type: 'APICallError', status: 429 });
    expect(r.failures).toEqual([
      { provider: null, model: null, type: 'APICallError', status: 429, stage: 'generation' },
    ]);
    expect(r.served.model).toBeNull();
    expect(r.cost.kind).toBe('unknown');
    expect(r.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    const json = JSON.stringify(r);
    expect(json).not.toContain(sentinel);
    expect(json).not.toContain('upstream said no');
  });

  it('does not fail generation when the metadata sink throws', async () => {
    const h = harness();
    const deps = { ...h.deps, sink: () => { throw new Error('sink exploded'); } };
    const out = await routedGenerate({ prompt: 'Capital of France?' }, deps);
    expect(out.text).toBe('Paris');
    expect(out.tier).toBe('fast');
  });

  it('does not fail generation when the sink throws on the error path either', async () => {
    const thrown = new Error('boom');
    const deps = {
      generateText: async () => {
        throw thrown;
      },
      sink: () => {
        throw new Error('sink exploded');
      },
    };
    await expect(routedGenerate({ prompt: 'x' }, deps)).rejects.toBe(thrown);
  });

  it('logs metadata only (no prompt/output content) when no sink is injected', async () => {
    const sentinel = 'SENTINEL_PROMPT_9f3c';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness();
    const { generateText, sink: _sink, ...rest } = h.deps;

    await routedGenerate({ prompt: sentinel }, { generateText, ...rest });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0].join(' ');
    expect(line).toContain('openrouter/auto');
    expect(line).not.toContain(sentinel);
  });
});
