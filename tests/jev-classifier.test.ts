/**
 * Tests for the OFF-BY-DEFAULT Jev shadow classifier adapter.
 *
 * Hermetic: every test clears the relevant env vars in beforeEach. No test makes
 * a live model call — the client is always injected (a spy) except where the
 * missing-credential path is explicitly under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteInput } from '../src/router';
import {
  classifyJev,
  createJevClient,
  preRouteOverride,
  resolveJevConfig,
  validateJevChoice,
  JEV_BASE_URL_DIRECT,
  JEV_BASE_URL_GATEWAY,
  JEV_CHOICE_KEY,
  JEV_MODEL_DIRECT,
  JEV_MODEL_GATEWAY,
  JevSchemaError,
  type JevClient,
  type JevTier,
} from '../src/jev-classifier';

const ENV_KEYS = [
  'TYPESAFE_API_KEY',
  'AI_GATEWAY_API_KEY',
  'JEV_TRANSPORT',
  'TYPESAFE_BASE_URL',
  'TYPESAFE_DEFAULT_MODEL',
] as const;

let snapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  snapshot = { ...process.env };
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  process.env = snapshot;
});

function fakeClient(
  responder: (req: any, opts: any) => unknown | Promise<unknown>,
): { client: JevClient; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async (req: any, opts: any) => responder(req, opts));
  return { client: { systemOne: spy as unknown as JevClient['systemOne'] }, spy };
}

function validPayload(overrides: Record<string, unknown> = {}): any {
  return {
    model: 'jev-1.13.0',
    answers: {
      [JEV_CHOICE_KEY]: {
        type: 'choice',
        choice: 'coding',
        confidence: 0.82,
        probabilities: { fast: 0.05, reasoning: 0.1, coding: 0.8, abstain: 0.05 },
      },
    },
    usage: { input_tokens: 120, output_tokens: 8 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------

describe('resolveJevConfig', () => {
  it('defaults to the direct TypeSafe transport pinned to jev-1.13.0', () => {
    const cfg = resolveJevConfig();
    expect(cfg.transport).toBe('direct');
    expect(cfg.model).toBe(JEV_MODEL_DIRECT);
    expect(cfg.model).toBe('jev-1.13.0');
    expect(cfg.baseURL).toBe(JEV_BASE_URL_DIRECT);
    expect(cfg.apiKeyEnv).toBe('TYPESAFE_API_KEY');
    expect(cfg.hasKey).toBe(false);
  });

  it('reports a present direct key without ever exposing it', () => {
    process.env.TYPESAFE_API_KEY = 'sk-direct-secret';
    const cfg = resolveJevConfig();
    expect(cfg.hasKey).toBe(true);
    expect(JSON.stringify(cfg)).not.toContain('sk-direct-secret');
  });

  it('selects the Gateway-compatible transport via JEV_TRANSPORT=gateway', () => {
    process.env.JEV_TRANSPORT = 'gateway';
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const cfg = resolveJevConfig();
    expect(cfg.transport).toBe('gateway');
    expect(cfg.model).toBe(JEV_MODEL_GATEWAY);
    expect(cfg.model).toBe('typesafe-ai/jev');
    expect(cfg.baseURL).toBe(JEV_BASE_URL_GATEWAY);
    expect(cfg.baseURL).toBe('https://ai-gateway.vercel.sh/typesafe');
    expect(cfg.apiKeyEnv).toBe('AI_GATEWAY_API_KEY');
    expect(cfg.hasKey).toBe(true);
  });

  it('is case/whitespace tolerant and falls back to direct for unknown values', () => {
    process.env.JEV_TRANSPORT = '  GATEWAY ';
    expect(resolveJevConfig().transport).toBe('gateway');
    process.env.JEV_TRANSPORT = 'nonsense';
    expect(resolveJevConfig().transport).toBe('direct');
  });

  it('lets TYPESAFE_BASE_URL override the default direct base URL', () => {
    process.env.TYPESAFE_BASE_URL = 'https://proxy.internal/typesafe';
    expect(resolveJevConfig().baseURL).toBe('https://proxy.internal/typesafe');
  });
});

describe('createJevClient', () => {
  it('builds a client from the resolved direct config (no network)', () => {
    process.env.TYPESAFE_API_KEY = 'sk-direct';
    const client = createJevClient(resolveJevConfig());
    expect(client.baseURL).toBe(JEV_BASE_URL_DIRECT);
    expect(client.defaultModel).toBe(JEV_MODEL_DIRECT);
  });

  it('builds a client from the resolved gateway config (no network)', () => {
    process.env.JEV_TRANSPORT = 'gateway';
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const client = createJevClient(resolveJevConfig());
    expect(client.baseURL).toBe(JEV_BASE_URL_GATEWAY);
    expect(client.defaultModel).toBe(JEV_MODEL_GATEWAY);
  });
});

// ---------------------------------------------------------------------------
// Deterministic short-circuits (no remote call)
// ---------------------------------------------------------------------------

describe('preRouteOverride', () => {
  it('reports forceTier before images and null when neither applies', () => {
    expect(preRouteOverride({ prompt: 'x', forceTier: 'fast' })).toBe('forceTier');
    expect(preRouteOverride({ prompt: 'x', images: ['u'] })).toBe('images');
    expect(preRouteOverride({ prompt: 'x' })).toBeNull();
  });

  it('honors forceTier over images', () => {
    expect(preRouteOverride({ prompt: 'x', forceTier: 'coding', images: ['u'] })).toBe('forceTier');
  });
});

describe('classifyJev short-circuits', () => {
  it('returns a deterministic forceTier result without calling the client', async () => {
    const { client, spy } = fakeClient(() => validPayload());
    const out = await classifyJev({ prompt: 'anything', forceTier: 'coding' }, client);
    expect(spy).not.toHaveBeenCalled();
    expect(out.tier).toBe('coding');
    expect(out.method).toBe('jev');
    expect(out.shortCircuit).toBe('forceTier');
    expect(out.confidence).toBe(1);
    expect(out.modelVersion).toBe('short-circuit');
    expect(out.latencyMs).toBe(0);
    expect(out.probabilities).toEqual({ fast: 0, reasoning: 0, coding: 0, abstain: 0 });
    expect(out.usage).toBeUndefined();
    expect(out.error).toBeUndefined();
  });

  it('returns a deterministic vision result for image input without calling the client', async () => {
    const { client, spy } = fakeClient(() => validPayload());
    const out = await classifyJev({ prompt: 'what is this?', images: ['https://x/y.png'] }, client);
    expect(spy).not.toHaveBeenCalled();
    expect(out.tier).toBe('vision');
    expect(out.shortCircuit).toBe('images');
    expect(out.modelVersion).toBe('short-circuit');
  });

  it('honors legacy hasImages', async () => {
    const out = await classifyJev({ prompt: 'what is this?', hasImages: true });
    expect(out.tier).toBe('vision');
    expect(out.shortCircuit).toBe('images');
  });

  it('forceTier wins over images', async () => {
    const out = await classifyJev({ prompt: 'x', forceTier: 'reasoning', images: ['u'] });
    expect(out.tier).toBe('reasoning');
    expect(out.shortCircuit).toBe('forceTier');
  });
});

// ---------------------------------------------------------------------------
// Happy path (injected client)
// ---------------------------------------------------------------------------

describe('classifyJev happy path', () => {
  it('maps a valid choice answer into the routing result', async () => {
    const { client, spy } = fakeClient(() => validPayload());
    const out = await classifyJev({ prompt: 'write a python function' }, client);

    expect(out.method).toBe('jev');
    expect(out.tier).toBe('coding');
    expect(out.modelVersion).toBe('jev-1.13.0');
    expect(out.confidence).toBeCloseTo(0.82, 12);
    expect(out.probabilities).toEqual({ fast: 0.05, reasoning: 0.1, coding: 0.8, abstain: 0.05 });
    expect(Number.isFinite(out.latencyMs)).toBe(true);
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    expect(out.usage).toEqual({ inputTokens: 120, outputTokens: 8 });
    expect(out.shortCircuit).toBeUndefined();
    expect(out.error).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns abstain when the model chooses abstain', async () => {
    const payload = validPayload();
    payload.answers[JEV_CHOICE_KEY] = {
      type: 'choice',
      choice: 'abstain',
      confidence: 0.4,
      probabilities: { fast: 0.2, reasoning: 0.2, coding: 0.2, abstain: 0.4 },
    };
    const out = await classifyJev({ prompt: 'unclear' }, fakeClient(() => payload).client);
    expect(out.tier).toBe('abstain');
    expect(out.method).toBe('jev');
    expect(out.error).toBeUndefined();
  });

  it('sends a text-only, tier-scoped choice request with bounded retries', async () => {
    const { client, spy } = fakeClient(() => validPayload());
    await classifyJev({ prompt: 'explain pointers' }, client);

    const [req, opts] = spy.mock.calls[0] as [any, any];
    expect(req.state).toBe('explain pointers');
    expect(req.model).toBe('jev-1.13.0');
    expect(Object.keys(req.questions)).toEqual([JEV_CHOICE_KEY]);
    expect(req.questions[JEV_CHOICE_KEY].type).toBe('choice');
    expect(Object.keys(req.questions[JEV_CHOICE_KEY].criteria).sort()).toEqual([
      'abstain',
      'coding',
      'fast',
      'reasoning',
    ]);
    expect(opts.retry.maxRetries).toBeLessThanOrEqual(2);
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('prefers an explicitly configured pinned model over the default', async () => {
    process.env.TYPESAFE_API_KEY = 'sk';
    const { client, spy } = fakeClient(() => validPayload({ model: 'jev-1.13.0' }));
    await classifyJev({ prompt: 'x' }, client, { model: 'jev-latest' });
    const [req] = spy.mock.calls[0] as [any];
    expect(req.model).toBe('jev-latest');
  });

  it('tolerates probability rounding within tolerance', async () => {
    const payload = validPayload();
    payload.answers[JEV_CHOICE_KEY].probabilities = {
      fast: 0.3333333,
      reasoning: 0.3333333,
      coding: 0.3333334,
      abstain: 0,
    };
    payload.answers[JEV_CHOICE_KEY].choice = 'coding';
    const out = await classifyJev({ prompt: 'x' }, fakeClient(() => payload).client);
    expect(out.tier).toBe('coding');
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('validateJevChoice', () => {
  it('accepts a well-formed choice answer and canonicalizes it', () => {
    const parsed = validateJevChoice(
      {
        type: 'choice',
        choice: 'fast',
        confidence: 0.7,
        probabilities: { fast: 0.7, reasoning: 0.1, coding: 0.1, abstain: 0.1 },
      },
      ['fast', 'reasoning', 'coding', 'abstain'],
    );
    expect(parsed.choice).toBe('fast');
    expect(parsed.confidence).toBe(0.7);
    expect(Object.keys(parsed.probabilities)).toEqual(['fast', 'reasoning', 'coding', 'abstain']);
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['undefined', undefined],
    ['wrong type', { type: 'noul', noul: 0.9 }],
    [
      'choice not in criteria',
      { type: 'choice', choice: 'vision', confidence: 0.9, probabilities: { fast: 1, reasoning: 0, coding: 0, abstain: 0 } },
    ],
    [
      'choice not a string',
      { type: 'choice', choice: 3, confidence: 0.9, probabilities: { fast: 1, reasoning: 0, coding: 0, abstain: 0 } },
    ],
    [
      'probabilities missing a key',
      { type: 'choice', choice: 'fast', confidence: 0.9, probabilities: { fast: 1, reasoning: 0, coding: 0 } },
    ],
    [
      'probabilities have an extra key',
      { type: 'choice', choice: 'fast', confidence: 0.9, probabilities: { fast: 1, reasoning: 0, coding: 0, abstain: 0, vision: 0 } },
    ],
    [
      'probability out of range',
      { type: 'choice', choice: 'fast', confidence: 0.9, probabilities: { fast: 1.2, reasoning: -0.2, coding: 0, abstain: 0 } },
    ],
    [
      'probability not finite',
      { type: 'choice', choice: 'fast', confidence: 0.9, probabilities: { fast: Number.NaN, reasoning: 0, coding: 0, abstain: 0 } },
    ],
    [
      'probabilities do not sum to 1',
      { type: 'choice', choice: 'fast', confidence: 0.9, probabilities: { fast: 0.2, reasoning: 0.1, coding: 0.1, abstain: 0.1 } },
    ],
    [
      'confidence not finite',
      { type: 'choice', choice: 'fast', confidence: Number.POSITIVE_INFINITY, probabilities: { fast: 1, reasoning: 0, coding: 0, abstain: 0 } },
    ],
    [
      'confidence out of range',
      { type: 'choice', choice: 'fast', confidence: 1.5, probabilities: { fast: 1, reasoning: 0, coding: 0, abstain: 0 } },
    ],
    [
      'confidence missing',
      { type: 'choice', choice: 'fast', probabilities: { fast: 1, reasoning: 0, coding: 0, abstain: 0 } },
    ],
    [
      'choice is not the unique probability argmax',
      {
        type: 'choice',
        choice: 'fast',
        confidence: 0.6,
        probabilities: { fast: 0.1, reasoning: 0.6, coding: 0.2, abstain: 0.1 },
      },
    ],
    [
      'choice is not one of the tied maxima',
      {
        type: 'choice',
        choice: 'coding',
        confidence: 0.4,
        probabilities: { fast: 0.4, reasoning: 0.4, coding: 0.1, abstain: 0.1 },
      },
    ],
    [
      'choice trails the maximum by more than the argmax tolerance',
      {
        type: 'choice',
        choice: 'fast',
        confidence: 0.5,
        probabilities: { fast: 0.5, reasoning: 0.5000011, coding: 0, abstain: 0 },
      },
    ],
  ])('rejects %s', (_name, answer) => {
    expect(() =>
      validateJevChoice(answer, ['fast', 'reasoning', 'coding', 'abstain']),
    ).toThrow(JevSchemaError);
  });

  it('rejects a choice that is not the argmax with a descriptive issue', () => {
    expect(() =>
      validateJevChoice(
        {
          type: 'choice',
          choice: 'fast',
          confidence: 0.6,
          probabilities: { fast: 0.1, reasoning: 0.6, coding: 0.2, abstain: 0.1 },
        },
        ['fast', 'reasoning', 'coding', 'abstain'],
      ),
    ).toThrow(/does not match the maximum probability/);
  });

  it('accepts a tie when the choice is one of the tied maxima', () => {
    const parsed = validateJevChoice(
      {
        type: 'choice',
        choice: 'reasoning',
        confidence: 0.4,
        probabilities: { fast: 0.4, reasoning: 0.4, coding: 0.1, abstain: 0.1 },
      },
      ['fast', 'reasoning', 'coding', 'abstain'],
    );
    expect(parsed.choice).toBe('reasoning');
    expect(parsed.probabilities).toEqual({ fast: 0.4, reasoning: 0.4, coding: 0.1, abstain: 0.1 });
  });

  it('accepts a choice within the argmax tolerance of the maximum (rounding)', () => {
    const parsed = validateJevChoice(
      {
        type: 'choice',
        choice: 'fast',
        confidence: 0.5,
        probabilities: { fast: 0.4999999, reasoning: 0.5, coding: 0, abstain: 0.0000001 },
      },
      ['fast', 'reasoning', 'coding', 'abstain'],
    );
    expect(parsed.choice).toBe('fast');
  });

  it('accepts a live-shaped Jev response whose choice is the argmax (compatibility)', () => {
    // Shape mirrors a real jev-1.13.0 /v1/systemone choice answer: choice is the
    // top of the distribution, confidence tracks it, all four keys present.
    const parsed = validateJevChoice(
      {
        type: 'choice',
        choice: 'coding',
        confidence: 0.82,
        probabilities: { fast: 0.05, reasoning: 0.1, coding: 0.8, abstain: 0.05 },
      },
      ['fast', 'reasoning', 'coding', 'abstain'],
    );
    expect(parsed.choice).toBe('coding');
    expect(parsed.confidence).toBe(0.82);
  });
});

describe('classifyJev schema failures', () => {
  it.each([
    ['missing answer key', validPayload({ answers: { other: { type: 'choice', choice: 'fast', confidence: 0.9, probabilities: { fast: 1, reasoning: 0, coding: 0, abstain: 0 } } } })],
    ['answers is not an object', validPayload({ answers: 'nope' })],
    ['answers missing', validPayload({ answers: undefined })],
    ['wrong answer type', validPayload({ answers: { [JEV_CHOICE_KEY]: { type: 'noul', noul: 0.9 } } })],
    ['misaligned probabilities', validPayload({ answers: { [JEV_CHOICE_KEY]: { type: 'choice', choice: 'fast', confidence: 0.9, probabilities: { fast: 1, reasoning: 0, coding: 0 } } } })],
    ['non-normalized probabilities', validPayload({ answers: { [JEV_CHOICE_KEY]: { type: 'choice', choice: 'fast', confidence: 0.9, probabilities: { fast: 0.4, reasoning: 0.1, coding: 0.1, abstain: 0.1 } } } })],
    ['choice does not match the probability argmax', validPayload({ answers: { [JEV_CHOICE_KEY]: { type: 'choice', choice: 'fast', confidence: 0.6, probabilities: { fast: 0.1, reasoning: 0.6, coding: 0.2, abstain: 0.1 } } } })],
    ['missing model', validPayload({ model: undefined })],
    ['non-string model', validPayload({ model: 7 })],
    ['malformed usage', validPayload({ usage: { input_tokens: 'x', output_tokens: 2 } })],
  ])('returns a recorded abstain (never regex) for %s', async (_name, payload) => {
    const out = await classifyJev({ prompt: 'x' }, fakeClient(() => payload).client);
    expect(out.tier).toBe('abstain');
    expect(out.method).toBe('jev');
    expect(out.error?.kind).toBe('schema');
    expect(out.confidence).toBe(0);
    expect(out.probabilities).toEqual({ fast: 0, reasoning: 0, coding: 0, abstain: 1 });
    expect(out.modelVersion).toBe('unavailable');
  });

  it('tolerates a missing usage block', async () => {
    const payload = validPayload();
    delete payload.usage;
    const out = await classifyJev({ prompt: 'x' }, fakeClient(() => payload).client);
    expect(out.tier).toBe('coding');
    expect(out.usage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Errors: recorded, never silently regex
// ---------------------------------------------------------------------------

describe('classifyJev error handling', () => {
  it('records a transport failure as abstain without falling back to regex', async () => {
    const { client } = fakeClient(() => {
      throw new Error('connection reset');
    });
    const out = await classifyJev({ prompt: 'x' }, client);
    expect(out.method).toBe('jev');
    expect(out.tier).toBe('abstain');
    expect(out.error?.kind).toBe('transport');
    expect(out.error?.message).toContain('connection reset');
  });

  it('records a missing credential as abstain without any remote call', async () => {
    const out = await classifyJev({ prompt: 'x' });
    expect(out.tier).toBe('abstain');
    expect(out.method).toBe('jev');
    expect(out.error?.kind).toBe('missing-key');
    expect(out.modelVersion).toBe('unavailable');
  });

  it('rethrows when throwOnError is set', async () => {
    const { client } = fakeClient(() => {
      throw new Error('boom');
    });
    await expect(classifyJev({ prompt: 'x' }, client, { throwOnError: true })).rejects.toThrow('boom');
  });

  it('enforces a total elapsed-time budget even if the client hangs', async () => {
    const spy = vi.fn(() => new Promise(() => {}));
    const client = { systemOne: spy as unknown as JevClient['systemOne'] };
    const started = Date.now();
    const out = await classifyJev({ prompt: 'x' }, client, { deadlineMs: 50 });
    expect(out.tier).toBe('abstain');
    expect(out.error?.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('records a caller aborts as an aborted result', async () => {
    const ac = new AbortController();
    ac.abort();
    const spy = vi.fn(
      (_req: any, opts: any) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const client = { systemOne: spy as unknown as JevClient['systemOne'] };
    const out = await classifyJev({ prompt: 'x' }, client, { signal: ac.signal, deadlineMs: 5000 });
    expect(out.tier).toBe('abstain');
    expect(out.error?.kind).toBe('aborted');
  });

  it('always reports method "jev" so callers can tell it is not the regex classifier', async () => {
    const { client } = fakeClient(() => validPayload());
    const out = await classifyJev({ prompt: 'x' }, client);
    expect(out.method).toBe('jev');
    const tiers: JevTier[] = ['fast', 'reasoning', 'coding', 'abstain'];
    expect(Object.keys(out.probabilities).sort()).toEqual([...tiers].sort());
  });
});

// ---------------------------------------------------------------------------
// Type-level sanity (compiled by tsc where included; asserted by vitest here)
// ---------------------------------------------------------------------------

describe('result shape', () => {
  it('exposes the documented RouteInput-facing contract', async () => {
    const input: RouteInput = { prompt: 'hello' };
    const { client } = fakeClient(() => validPayload());
    const out = await classifyJev(input, client);
    expect(Object.keys(out).sort()).toEqual(
      ['confidence', 'latencyMs', 'method', 'modelVersion', 'probabilities', 'tier', 'usage'].sort(),
    );
  });
});
