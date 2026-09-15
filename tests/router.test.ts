import { afterEach, describe, expect, it } from 'vitest';
import {
  classify,
  fastTierProvider,
  modelForInput,
  setFastTierProvider,
  type RouteInput,
} from '../src/router';

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

  it('ignores an invalid env value', () => {
    process.env.FAST_TIER_PROVIDER = 'nonsense';
    expect(fastTierProvider()).toBe('openrouter');
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
