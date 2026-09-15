import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkOpenRouterCredits,
  formatCreditWarning,
  type CreditStatus,
} from '../src/credits';

function mockFetchJson(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('checkOpenRouterCredits — threshold levels', () => {
  const origFetch = globalThis.fetch;
  const origKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = origKey;
  });

  it('reports OK when balance is above the warn threshold', async () => {
    globalThis.fetch = mockFetchJson({ data: { total_credits: 100, total_usage: 10 } });
    const s = await checkOpenRouterCredits({ warnUsd: 5, criticalUsd: 1 });
    expect(s.balanceUsd).toBeCloseTo(90);
    expect(s.level).toBe('ok');
  });

  it('reports LOW at/under the warn threshold', async () => {
    globalThis.fetch = mockFetchJson({ data: { total_credits: 20, total_usage: 16 } });
    const s = await checkOpenRouterCredits({ warnUsd: 5, criticalUsd: 1 });
    expect(s.balanceUsd).toBeCloseTo(4);
    expect(s.level).toBe('low');
  });

  it('reports CRITICAL at/under the critical threshold', async () => {
    globalThis.fetch = mockFetchJson({ data: { total_credits: 20, total_usage: 19.5 } });
    const s = await checkOpenRouterCredits({ warnUsd: 5, criticalUsd: 1 });
    expect(s.balanceUsd).toBeCloseTo(0.5);
    expect(s.level).toBe('critical');
  });

  it('returns unknown when the key is missing', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const s = await checkOpenRouterCredits();
    expect(s.level).toBe('unknown');
    expect(s.balanceUsd).toBeNull();
    expect(s.error).toBeTruthy();
  });

  it('returns unknown on a non-OK HTTP response', async () => {
    globalThis.fetch = mockFetchJson({}, false, 500);
    const s = await checkOpenRouterCredits();
    expect(s.level).toBe('unknown');
    expect(s.error).toContain('500');
  });

  it('returns unknown on an unexpected response shape', async () => {
    globalThis.fetch = mockFetchJson({ data: {} });
    const s = await checkOpenRouterCredits();
    expect(s.level).toBe('unknown');
  });
});

describe('formatCreditWarning', () => {
  const base: CreditStatus = {
    provider: 'openrouter',
    balanceUsd: 4,
    usedUsd: 16,
    level: 'low',
    message: 'OpenRouter: $4.00 remaining',
  };

  it('prefixes a warning icon and LOW label', () => {
    const line = formatCreditWarning(base);
    expect(line).toContain('⚠️');
    expect(line).toContain('LOW');
  });

  it('prefixes a critical icon and CRITICAL label', () => {
    const line = formatCreditWarning({ ...base, level: 'critical' });
    expect(line).toContain('🚨');
    expect(line).toContain('CRITICAL');
  });

  it('marks OK cleanly', () => {
    const line = formatCreditWarning({ ...base, level: 'ok' });
    expect(line).toContain('✅');
  });
});
