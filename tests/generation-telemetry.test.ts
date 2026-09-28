import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  POLICY_ID,
  POLICY_VERSION,
  TELEMETRY_VERSION,
  buildGenerationRecord,
  buildPolicy,
  describeClassifier,
  extractServedIdentity,
  newRequestId,
  policyDescriptor,
  resolveGenerationCost,
  sanitizeError,
  type PolicyShape,
  type TelemetryPolicy,
} from '../src/generation-telemetry';

// Fail-closed network guard: these are pure-function tests and must never
// reach a provider, even if a future change adds one behind the seam.
beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('TEST_NETWORK_BLOCKED: a test attempted an external HTTP call');
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const SENSITIVE_PROMPT = 'SENTINEL_PROMPT_TEXT_9f3c';
const SECRET = 'sk-SENTINEL_SECRET_KEY_9f3c';

const SHAPE: PolicyShape = {
  profile: 'quality',
  models: { fast: 'openai/gpt-4o-mini', reasoning: 'anthropic/claude-opus-4.8' },
  fallbacks: { fast: ['google/gemini-2.5-flash-lite'], reasoning: ['openai/o3'] },
  fastTierDefault: 'openrouter',
};

const POLICY: TelemetryPolicy = buildPolicy(SHAPE);

describe('policy descriptor (phase-0 baseline)', () => {
  it('is deterministic for an identical policy shape', () => {
    expect(policyDescriptor(SHAPE)).toBe(policyDescriptor({ ...SHAPE }));
    expect(buildPolicy(SHAPE)).toEqual(buildPolicy({ ...SHAPE }));
  });

  it('changes when the model policy changes', () => {
    const other = policyDescriptor({
      ...SHAPE,
      models: { ...SHAPE.models, fast: 'amazon/nova-micro' },
    });
    expect(other).not.toBe(policyDescriptor(SHAPE));
    expect(
      policyDescriptor({ ...SHAPE, fallbacks: { ...SHAPE.fallbacks, fast: [] } }),
    ).not.toBe(policyDescriptor(SHAPE));
    expect(policyDescriptor({ ...SHAPE, profile: 'budget' })).not.toBe(policyDescriptor(SHAPE));
    expect(policyDescriptor({ ...SHAPE, fastTierDefault: 'gateway' })).not.toBe(
      policyDescriptor(SHAPE),
    );
  });

  it('is a privacy-safe hash, not a dump of the model ids', () => {
    const d = policyDescriptor(SHAPE);
    expect(d).toMatch(/^[0-9a-f]{12}$/);
    expect(d).not.toContain('openai');
    expect(d).not.toContain('/');
  });

  it('carries a stable id + version', () => {
    expect(POLICY.id).toBe(POLICY_ID);
    expect(POLICY.version).toBe(POLICY_VERSION);
    expect(POLICY.descriptor).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('newRequestId', () => {
  it('returns a v4 UUID', () => {
    expect(newRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(newRequestId()).not.toBe(newRequestId());
  });
});

describe('describeClassifier', () => {
  it("records requested/effective and no fallback when regex was the plan", () => {
    expect(
      describeClassifier({
        requested: 'regex',
        semanticPlanned: false,
        effective: 'regex',
        tier: 'fast',
      }),
    ).toEqual({
      requested: 'regex',
      semanticPlanned: false,
      effective: 'regex',
      fallback: false,
      tier: 'fast',
    });
  });

  it('flags a fallback only when an embeddings attempt was planned but regex ran', () => {
    const planned = describeClassifier({
      requested: 'semantic',
      semanticPlanned: true,
      effective: 'regex',
      tier: 'coding',
    });
    expect(planned.fallback).toBe(true);
    expect(planned.requested).toBe('semantic');
    expect(planned.effective).toBe('regex');

    // 'auto' without an embeddings key is the designed regex path, not a fallback.
    const auto = describeClassifier({
      requested: 'auto',
      semanticPlanned: false,
      effective: 'regex',
      tier: 'fast',
    });
    expect(auto.fallback).toBe(false);

    const semantic = describeClassifier({
      requested: 'auto',
      semanticPlanned: true,
      effective: 'semantic',
      tier: 'reasoning',
    });
    expect(semantic.fallback).toBe(false);
  });
});

describe('extractServedIdentity — gateway', () => {
  const gwMeta = (gateway: Record<string, unknown>) => ({ gateway });

  it('uses the winning provider attempt when finalProvider is missing', () => {
    const id = extractServedIdentity({
      selectedProvider: 'gateway',
      selectedModel: 'google/gemini-2.5-pro',
      providerMetadata: gwMeta({ routing: {
        modelAttempts: [{ canonicalSlug: 'google/gemini-2.5-pro', success: true,
          providerAttempts: [
            { provider: 'vertex', success: false },
            { provider: 'bedrock', success: true },
          ] }],
      } }),
    });
    expect(id.served.provider).toBe('bedrock');
    expect(id.served.fallback).toBe(true);
    expect(id.fallbackAttempts).toEqual([
      { provider: 'vertex', model: 'google/gemini-2.5-pro', status: 'failed' },
    ]);
  });

  it('recognizes documented gateway boolean success and nested provider retries', () => {
    const id = extractServedIdentity({
      selectedProvider: 'gateway',
      selectedModel: 'anthropic/claude-opus-4.8',
      providerMetadata: gwMeta({
        generationId: 'gen_gw_real_shape',
        cost: '0.00454',
        routing: {
          finalProvider: 'openai',
          modelAttempts: [
            { modelId: 'anthropic:claude-opus-4.8', canonicalSlug: 'anthropic/claude-opus-4.8', success: false,
              providerAttempts: [{ provider: 'anthropic', success: false }] },
            { modelId: 'openai:o3', canonicalSlug: 'openai/o3', success: true,
              providerAttempts: [{ provider: 'openai', success: true }] },
          ],
        },
      }),
    });
    expect(id.served.model).toBe('openai/o3');
    expect(id.served.provider).toBe('openai');
    expect(id.served.fallback).toBe(true);
    expect(id.fallbackAttempts).toEqual([
      { provider: 'anthropic', model: 'anthropic/claude-opus-4.8', status: 'failed' },
    ]);
  });

  it('records failed provider attempts inside a failed model before the winning fallback', () => {
    const id = extractServedIdentity({
      selectedProvider: 'gateway',
      selectedModel: 'anthropic/claude-opus-4.8',
      providerMetadata: gwMeta({ routing: {
        finalProvider: 'openai',
        modelAttempts: [
          { canonicalSlug: 'anthropic/claude-opus-4.8', success: false,
            providerAttempts: [
              { provider: 'bedrock', success: false },
              { provider: 'anthropic', success: false },
            ] },
          { canonicalSlug: 'openai/o3', success: true,
            providerAttempts: [{ provider: 'openai', success: true }] },
        ],
      } }),
    });
    expect(id.served.model).toBe('openai/o3');
    expect(id.fallbackAttempts).toEqual([
      { provider: 'bedrock', model: 'anthropic/claude-opus-4.8', status: 'failed' },
      { provider: 'anthropic', model: 'anthropic/claude-opus-4.8', status: 'failed' },
    ]);
  });

  it('recognizes provider fallback within one successful gateway model attempt', () => {
    const id = extractServedIdentity({
      selectedProvider: 'gateway',
      selectedModel: 'zai/glm-5',
      providerMetadata: gwMeta({ routing: {
        finalProvider: 'novita',
        modelAttempts: [{ modelId: 'novita:zai-org/glm-5', canonicalSlug: 'zai/glm-5', success: true,
          providerAttempts: [
            { provider: 'novita', credentialType: 'byok', success: false },
            { provider: 'novita', credentialType: 'system', success: true },
          ] }],
      } }),
    });
    expect(id.served.model).toBe('zai/glm-5');
    expect(id.served.fallback).toBe(true);
    expect(id.fallbackAttempts).toEqual([
      { provider: 'novita', model: 'zai/glm-5', status: 'failed' },
    ]);
  });

  it('takes the served model from the last successful model attempt + routing.finalProvider', () => {
    const id = extractServedIdentity({
      selectedProvider: 'gateway',
      selectedModel: 'anthropic/claude-opus-4.8',
      response: { id: 'sdk-uuid-0000', modelId: 'anthropic/claude-opus-4.8' },
      providerMetadata: gwMeta({
        generationId: 'gen_gw_1',
        cost: '0.0021',
        routing: {
          finalProvider: 'openai',
          modelAttempts: [
            { provider: 'anthropic', model: 'anthropic/claude-opus-4.8', status: 'error' },
            { provider: 'openai', model: 'openai/o3', canonicalSlug: 'openai/o3', status: 'success' },
          ],
        },
      }),
    });

    expect(id.served).toEqual({
      provider: 'openai',
      model: 'openai/o3',
      generationId: 'gen_gw_1',
      source: 'gateway-metadata',
      fallback: true,
    });
    expect(id.fallbackAttempts).toEqual([
      { provider: 'anthropic', model: 'anthropic/claude-opus-4.8', status: 'failed' },
    ]);
    expect(id.billedUSD).toBeCloseTo(0.0021, 10);
    expect(id.billedSource).toBe('gateway-metadata');
  });

  it('reports no fallback when the last successful attempt is the selected model', () => {
    const id = extractServedIdentity({
      selectedProvider: 'gateway',
      selectedModel: 'openai/gpt-4o',
      providerMetadata: gwMeta({
        generationId: 'gen_gw_2',
        routing: {
          finalProvider: 'openai',
          modelAttempts: [
            { model: 'openai/gpt-4o', canonicalSlug: 'openai/gpt-4o', status: 'success' },
          ],
        },
      }),
    });
    expect(id.served.model).toBe('openai/gpt-4o');
    expect(id.served.fallback).toBe(false);
    expect(id.fallbackAttempts).toEqual([]);
  });

  it('prefers canonicalSlug for the served model', () => {
    const id = extractServedIdentity({
      selectedProvider: 'gateway',
      selectedModel: 'amazon/nova-micro',
      providerMetadata: gwMeta({
        routing: {
          modelAttempts: [
            { model: 'nova-micro', canonicalSlug: 'amazon/nova-micro', status: 'success' },
          ],
        },
      }),
    });
    expect(id.served.model).toBe('amazon/nova-micro');
  });

  it('NEVER treats result.response.id/modelId as authoritative gateway identity', () => {
    const id = extractServedIdentity({
      selectedProvider: 'gateway',
      selectedModel: 'anthropic/claude-opus-4.8',
      response: { id: 'sdk-uuid-should-not-be-used', modelId: 'anthropic/claude-opus-4.8' },
      providerMetadata: undefined,
    });
    expect(id.served).toEqual({
      provider: null,
      model: null,
      generationId: null,
      source: 'none',
      fallback: false,
    });
    expect(id.billedUSD).toBeNull();
    expect(id.billedSource).toBeNull();
    expect(id.fallbackAttempts).toEqual([]);
  });

  it('marks an unattributed multi-attempt chain as a fallback without inventing a model', () => {
    const id = extractServedIdentity({
      selectedProvider: 'gateway',
      selectedModel: 'anthropic/claude-opus-4.8',
      providerMetadata: gwMeta({
        routing: {
          finalProvider: 'google',
          modelAttempts: [{ provider: 'anthropic', model: 'anthropic/claude-opus-4.8' }, { provider: 'google' }],
        },
      }),
    });
    expect(id.served.model).toBeNull();
    expect(id.served.provider).toBe('google');
    expect(id.served.fallback).toBe(true);
    expect(id.fallbackAttempts).toHaveLength(2);
    expect(id.fallbackAttempts[1].status).toBe('unknown');
  });

  it('accepts only a finite, non-negative gateway cost string', () => {
    const billedFor = (cost: unknown) =>
      extractServedIdentity({
        selectedProvider: 'gateway',
        selectedModel: 'openai/gpt-4o',
        providerMetadata: gwMeta({ cost }),
      }).billedUSD;

    expect(billedFor('0')).toBe(0);
    expect(billedFor('0.0000042')).toBeCloseTo(0.0000042, 12);
    expect(billedFor('-1')).toBeNull();
    expect(billedFor('abc')).toBeNull();
    expect(billedFor('Infinity')).toBeNull();
    expect(billedFor(1.5)).toBeNull(); // gateway sends USD as a string
    expect(billedFor(null)).toBeNull();
    expect(billedFor({})).toBeNull();
  });
});

describe('extractServedIdentity — openrouter', () => {
  it('uses the concrete response.modelId, response.id and openrouter provider metadata', () => {
    const id = extractServedIdentity({
      selectedProvider: 'openrouter',
      selectedModel: 'openrouter/auto',
      response: { id: 'gen-or-123', modelId: 'openai/gpt-4o-mini' },
      providerMetadata: {
        openrouter: { provider: 'OpenAI', usage: { totalTokens: 30, cost: 0.00123 } },
      },
    });
    expect(id.served).toEqual({
      provider: 'OpenAI',
      model: 'openai/gpt-4o-mini',
      generationId: 'gen-or-123',
      source: 'openrouter-metadata',
      fallback: false,
    });
    expect(id.billedUSD).toBeCloseTo(0.00123, 10);
    expect(id.billedSource).toBe('openrouter-metadata');
  });

  it('refuses an alias echoed back as the served model', () => {
    const id = extractServedIdentity({
      selectedProvider: 'openrouter',
      selectedModel: 'openrouter/auto',
      response: { id: 'gen-or-124', modelId: 'openrouter/auto' },
      providerMetadata: { openrouter: { provider: 'OpenRouter' } },
    });
    expect(id.served.model).toBeNull();
    expect(id.served.generationId).toBe('gen-or-124');
    expect(id.served.source).toBe('openrouter-metadata');
  });

  it('treats empty/odd metadata defensively and leaves cost unknown when absent', () => {
    const id = extractServedIdentity({
      selectedProvider: 'openrouter',
      selectedModel: 'openrouter/auto',
      response: { modelId: 'anthropic/claude-sonnet-4' },
      providerMetadata: { openrouter: { provider: '', usage: { cost: 'free' } } },
    });
    expect(id.served.provider).toBeNull();
    expect(id.served.model).toBe('anthropic/claude-sonnet-4');
    expect(id.served.generationId).toBeNull();
    expect(id.billedUSD).toBeNull();
    expect(id.served.source).toBe('openrouter-metadata');

    const none = extractServedIdentity({
      selectedProvider: 'openrouter',
      selectedModel: 'openrouter/auto',
      providerMetadata: null,
    });
    expect(none.served.source).toBe('none');
    expect(none.served.model).toBeNull();
  });

  it('survives hostile metadata shapes without throwing', () => {
    const id = extractServedIdentity({
      selectedProvider: 'gateway',
      selectedModel: 'openai/gpt-4o',
      providerMetadata: {
        gateway: { generationId: 42, cost: [], routing: 'nope', modelAttempts: {} },
      } as never,
    });
    expect(id.served.generationId).toBeNull();
    expect(id.served.source).toBe('gateway-metadata');
    expect(id.served.model).toBeNull();
    expect(id.billedUSD).toBeNull();
    expect(id.fallbackAttempts).toEqual([]);
  });
});

describe('resolveGenerationCost', () => {
  const tokens = { inputTokens: 1000, outputTokens: 500 };

  it('reports in-band billed cost as actual', () => {
    const { cost, estimate } = resolveGenerationCost({
      provider: 'gateway',
      selectedModel: 'openai/gpt-4o',
      served: {
        provider: 'openai',
        model: 'openai/gpt-4o',
        generationId: 'gen_1',
        source: 'gateway-metadata',
        fallback: false,
      },
      tokens,
      billedUSD: 0.0123,
      billedSource: 'gateway-metadata',
    });
    expect(cost.kind).toBe('actual');
    expect(cost.actualUSD).toBeCloseTo(0.0123, 10);
    expect(cost.estimatedUSD).toBeNull();
    expect(cost.source).toBe('gateway-metadata');
    // the legacy GenerateOutput.cost field stays a static estimate, untweaked
    expect(estimate.status).toBe('estimated');
    expect(estimate.model).toBe('openai/gpt-4o');
  });

  it('falls back to the static estimate for the selected model when nothing fell back', () => {
    const { cost, estimate } = resolveGenerationCost({
      provider: 'gateway',
      selectedModel: 'openai/gpt-4o',
      served: { provider: null, model: null, generationId: null, source: 'none', fallback: false },
      tokens,
      billedUSD: null,
      billedSource: null,
    });
    expect(cost.kind).toBe('estimated');
    expect(cost.estimatedUSD).toBeCloseTo(estimate.estimatedUSD as number, 12);
    expect(cost.source).toBe('static-price-table');
    expect(cost.estimatedForModel).toBe('openai/gpt-4o');
    expect(cost.actualUSD).toBeNull();
  });

  it('never prices the selected alias when the served model is unknown after a fallback', () => {
    const { cost, estimate } = resolveGenerationCost({
      provider: 'gateway',
      selectedModel: 'openai/gpt-4o', // priceable on its own
      served: {
        provider: 'openai',
        model: null,
        generationId: 'gen_2',
        source: 'gateway-metadata',
        fallback: true,
      },
      tokens,
      billedUSD: null,
      billedSource: null,
    });
    expect(cost.kind).toBe('unknown');
    expect(cost.estimatedUSD).toBeNull();
    expect(cost.actualUSD).toBeNull();
    expect(cost.source).toBe('none');
    expect(estimate.status).toBe('unknown');
    expect(estimate.estimatedUSD).toBeNull();
  });

  it('estimates the ACTUAL served model when a fallback is attributable', () => {
    const { cost } = resolveGenerationCost({
      provider: 'gateway',
      selectedModel: 'anthropic/claude-opus-4.8',
      served: {
        provider: 'openai',
        model: 'openai/gpt-4o',
        generationId: 'gen_3',
        source: 'gateway-metadata',
        fallback: true,
      },
      tokens,
      billedUSD: null,
      billedSource: null,
    });
    expect(cost.kind).toBe('estimated');
    expect(cost.estimatedForModel).toBe('openai/gpt-4o');
    // 1000/1e6*5 + 500/1e6*15
    expect(cost.estimatedUSD).toBeCloseTo(0.0125, 12);
  });

  it('reports unknown for openrouter/auto with no in-band cost', () => {
    const { cost } = resolveGenerationCost({
      provider: 'openrouter',
      selectedModel: 'openrouter/auto',
      served: {
        provider: null,
        model: null,
        generationId: null,
        source: 'none',
        fallback: false,
      },
      tokens,
      billedUSD: null,
      billedSource: null,
    });
    expect(cost.kind).toBe('unknown');
    expect(cost.estimatedUSD).toBeNull();
  });

  it('reports local compute as unknown', () => {
    const { cost } = resolveGenerationCost({
      provider: 'local',
      selectedModel: 'local-model',
      served: { provider: null, model: null, generationId: null, source: 'none', fallback: false },
      tokens,
      billedUSD: null,
      billedSource: null,
    });
    expect(cost.kind).toBe('unknown');
  });
});

describe('sanitizeError', () => {
  it('keeps only the error class name and a numeric HTTP status', () => {
    expect(sanitizeError(new Error(SECRET))).toEqual({ type: 'Error', status: null });
    expect(
      sanitizeError(Object.assign(new Error(SECRET), { name: 'APICallError', statusCode: 429 })),
    ).toEqual({ type: 'APICallError', status: 429 });
    expect(
      sanitizeError(Object.assign(new Error('x'), { name: 'GatewayError', status: 503 })),
    ).toEqual({ type: 'GatewayError', status: 503 });
  });

  it('never leaks the message or the raw error value', () => {
    expect(JSON.stringify(sanitizeError(new Error(SECRET)))).not.toContain(SECRET);
    expect(JSON.stringify(sanitizeError(SECRET))).not.toContain('SENTINEL');
    expect(sanitizeError(SECRET)).toEqual({ type: 'Error', status: null });
    expect(sanitizeError({ message: SECRET })).toEqual({ type: 'Error', status: null });
    expect(sanitizeError(null)).toEqual({ type: 'Error', status: null });
    expect(sanitizeError(undefined)).toEqual({ type: 'Error', status: null });
  });

  it('rejects a non-class-like name and an out-of-range status', () => {
    expect(sanitizeError(Object.assign(new Error('x'), { name: 'weird name!' }))).toEqual({
      type: 'Error',
      status: null,
    });
    expect(sanitizeError(Object.assign(new Error('x'), { statusCode: 99 }))).toEqual({
      type: 'Error',
      status: null,
    });
    expect(sanitizeError(Object.assign(new Error('x'), { statusCode: 600 }))).toEqual({
      type: 'Error',
      status: null,
    });
    expect(sanitizeError(Object.assign(new Error('x'), { status: 'nope' }))).toEqual({
      type: 'Error',
      status: null,
    });
  });
});

describe('buildGenerationRecord', () => {
  const base = {
    requestId: '11111111-2222-4333-8444-555555555555',
    policy: POLICY,
    classifier: describeClassifier({
      requested: 'regex' as const,
      semanticPlanned: false,
      effective: 'regex' as const,
      tier: 'fast' as const,
    }),
    selected: { provider: 'openrouter' as const, model: 'openrouter/auto' },
    identity: extractServedIdentity({
      selectedProvider: 'openrouter',
      selectedModel: 'openrouter/auto',
      response: { id: 'gen-or-9', modelId: 'openai/gpt-4o-mini' },
      providerMetadata: { openrouter: { provider: 'OpenAI', usage: { cost: 0.002 } } },
    }),
    tokens: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    latencyMs: 123,
  };

  it('assembles a complete, versioned baseline record', () => {
    const record = buildGenerationRecord(base);
    expect(record.version).toBe(TELEMETRY_VERSION);
    expect(record.status).toBe('ok');
    expect(record.requestId).toBe(base.requestId);
    expect(record.policy).toEqual(POLICY);
    expect(record.classifier.tier).toBe('fast');
    expect(record.selected).toEqual({ provider: 'openrouter', model: 'openrouter/auto' });
    expect(record.served.model).toBe('openai/gpt-4o-mini');
    expect(record.served.generationId).toBe('gen-or-9');
    expect(record.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(record.latencyMs).toBe(123);
    expect(record.cost.kind).toBe('actual');
    expect(record.error).toBeNull();
  });

  it('does not estimate static cost for a failed request with no token usage', () => {
    const record = buildGenerationRecord({
      ...base,
      selected: { provider: 'gateway', model: 'anthropic/claude-opus-4.8' },
      identity: extractServedIdentity({ selectedProvider: 'gateway', selectedModel: 'anthropic/claude-opus-4.8' }),
      status: 'error',
      error: { type: 'APICallError', status: 429 },
      tokens: null,
    });
    expect(record.usage.inputTokens).toBeNull();
    expect(record.cost.kind).toBe('unknown');
    expect(record.cost.estimatedUSD).toBeNull();
  });

  it('does not invent a zero-cost estimate when success has no usage or billable metadata', () => {
    const record = buildGenerationRecord({
      ...base,
      selected: { provider: 'gateway', model: 'anthropic/claude-opus-4.8' },
      identity: extractServedIdentity({ selectedProvider: 'gateway', selectedModel: 'anthropic/claude-opus-4.8' }),
      tokens: null,
    });
    expect(record.cost.kind).toBe('unknown');
    expect(record.cost.estimatedUSD).toBeNull();
  });

  it('records a thrown generation as an error without the message or content', () => {
    const thrown = Object.assign(new Error(`${SENSITIVE_PROMPT} ${SECRET}`), {
      name: 'APICallError',
      statusCode: 429,
    });
    const record = buildGenerationRecord({
      ...base,
      identity: extractServedIdentity({
        selectedProvider: 'openrouter',
        selectedModel: 'openrouter/auto',
      }),
      status: 'error',
      error: sanitizeError(thrown),
      failureStage: 'generation',
      tokens: null,
    });

    expect(record.status).toBe('error');
    expect(record.error).toEqual({ type: 'APICallError', status: 429 });
    expect(record.failures).toEqual([
      { provider: null, model: null, type: 'APICallError', status: 429, stage: 'generation' },
    ]);
    expect(record.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    expect(record.cost.kind).toBe('unknown');
    expect(record.served.model).toBeNull();
  });

  it('never echoes prompt, response text, keys or headers passed alongside the record inputs', () => {
    const record = buildGenerationRecord({
      ...base,
      // hostile extras: nothing the caller smuggles in may survive into the record
      prompt: SENSITIVE_PROMPT,
      text: SENSITIVE_PROMPT,
      messages: [{ role: 'user', content: SENSITIVE_PROMPT }],
      headers: { authorization: `Bearer ${SECRET}` },
    } as never);
    const json = JSON.stringify(record);
    expect(json).not.toContain('SENTINEL');
    expect(json).not.toContain('sk-');
    expect(Object.keys(record).sort()).toEqual(
      [
        'classifier',
        'cost',
        'error',
        'failures',
        'fallbackAttempts',
        'latencyMs',
        'policy',
        'requestId',
        'selected',
        'served',
        'status',
        'usage',
        'version',
      ].sort(),
    );
  });

  it('survives a non-finite latency and unknown token usage', () => {
    const record = buildGenerationRecord({
      ...base,
      tokens: { inputTokens: null, outputTokens: null },
      latencyMs: Number.NaN,
    });
    expect(record.latencyMs).toBeNull();
    expect(record.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    expect(record.cost.kind).toBe('actual'); // billed cost is independent of token counts
  });
});
