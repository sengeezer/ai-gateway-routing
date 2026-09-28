import { describe, expect, it } from 'vitest';
import { estimateCost, formatCost } from '../src/cost-estimator';

/**
 * Work package 1a — cost honesty.
 *
 * Invariant under test: an unknown or dynamic price is reported as UNKNOWN
 * (estimatedUSD === null, status 'unknown'), never as 0 / "(free)". A known
 * static-table price keeps its estimate but is labelled as an estimate with an
 * explicit source — it is never presented as actual billed cost.
 */
describe('estimateCost — unknown and dynamic pricing is unknown, not zero', () => {
  it('returns explicit unknown for a model absent from the price table', () => {
    const c = estimateCost('some/new-model-x', 'gateway', 1000, 1000);
    expect(c.estimatedUSD).toBeNull();
    expect(c.inputCostUSD).toBeNull();
    expect(c.outputCostUSD).toBeNull();
    expect(c.status).toBe('unknown');
    expect(c.source).toBe('none');
    expect(c.note.length).toBeGreaterThan(0);
  });

  it('never returns a guessed positive number for an unknown model', () => {
    const c = estimateCost('some/new-model-x', 'gateway', 1_000_000, 1_000_000);
    expect(c.estimatedUSD).not.toBe(0);
    expect(c.estimatedUSD).toBeNull();
  });

  it('treats openrouter/auto as unknown (selected model is dynamic, $2/$6 was a guess)', () => {
    const c = estimateCost('openrouter/auto', 'openrouter', 1000, 1000);
    expect(c.estimatedUSD).toBeNull();
    expect(c.status).toBe('unknown');
    expect(c.source).toBe('none');
    // The provenance note must explain why it cannot be priced statically.
    expect(c.note).toMatch(/dynamic|per request|selected model/i);
  });

  it('records provider and token counts even when cost is unknown', () => {
    const c = estimateCost('openrouter/auto', 'openrouter', 123, 456);
    expect(c.model).toBe('openrouter/auto');
    expect(c.provider).toBe('openrouter');
    expect(c.inputTokens).toBe(123);
    expect(c.outputTokens).toBe(456);
  });
});

describe('estimateCost — protected known static estimates keep provenance', () => {
  it('prices a known gateway model from the static table as an estimate', () => {
    const c = estimateCost('openai/gpt-4o-mini', 'gateway', 1000, 1000);
    expect(c.status).toBe('estimated');
    expect(c.source).toBe('static-price-table');
    expect(c.inputCostUSD).toBeCloseTo(0.00015);
    expect(c.outputCostUSD).toBeCloseTo(0.0006);
    expect(c.estimatedUSD).toBeCloseTo(0.00075);
  });

  it('never turns an unknown token count into a zero-dollar estimate', () => {
    const c = estimateCost('anthropic/claude-opus-4.8', 'gateway', Number.NaN, 0);
    expect(c.status).toBe('unknown');
    expect(c.estimatedUSD).toBeNull();
  });

  it('keeps a known published free-tier rate as an estimate of zero (distinct from unknown)', () => {
    const c = estimateCost('inclusionai/ling-3.0-flash-vl-free', 'gateway', 5000, 5000);
    expect(c.status).toBe('estimated');
    expect(c.source).toBe('static-price-table');
    expect(c.estimatedUSD).toBe(0);
  });

  it('labels every estimated result as an estimate, not actual cost', () => {
    const c = estimateCost('openai/gpt-4o-mini', 'gateway', 1000, 1000);
    expect(c.note).toMatch(/estimat/i);
    expect(c.note).not.toMatch(/actual billed/i);
  });
});

describe('estimateCost — local compute is not globally "free"', () => {
  it('reports local provider cost as unknown, not zero/free', () => {
    const c = estimateCost('local-model', 'local', 1000, 1000);
    expect(c.estimatedUSD).toBeNull();
    expect(c.status).toBe('unknown');
    expect(c.provider).toBe('local');
  });

  it('explains local compute is not API-billed but is not zero cost either', () => {
    const c = estimateCost('local-model', 'local', 1000, 1000);
    expect(c.note.length).toBeGreaterThan(0);
    expect(c.note).not.toContain('(free)');
  });
});

describe('formatCost — never renders unknown as free', () => {
  it('renders an unknown cost as unknown, never "(free)" and never a dollar figure', () => {
    const s = formatCost(estimateCost('openrouter/auto', 'openrouter', 1000, 1000));
    expect(s).toMatch(/unknown/i);
    expect(s).not.toContain('(free)');
    expect(s).not.toContain('$');
  });

  it('renders an unknown gateway model as unknown, never "(free)"', () => {
    const s = formatCost(estimateCost('some/new-model-x', 'gateway', 10, 10));
    expect(s).toMatch(/unknown/i);
    expect(s).not.toContain('(free)');
  });

  it('renders a known zero (free-tier rate) as free tier, not unknown', () => {
    const s = formatCost(estimateCost('inclusionai/ling-3.0-flash-vl-free', 'gateway', 10, 10));
    expect(s).not.toMatch(/unknown/i);
    expect(s).toMatch(/free tier/i);
  });

  it('does not label a paid model free when measured token counts happen to be zero', () => {
    const s = formatCost(estimateCost('openai/gpt-4o-mini', 'gateway', 0, 0));
    expect(s).not.toMatch(/free/i);
  });

  it('renders a known positive estimate with a tilde-prefixed dollar figure', () => {
    const s = formatCost(estimateCost('openai/gpt-4o-mini', 'gateway', 1000, 1000));
    expect(s).toMatch(/^~\$/);
  });
});
