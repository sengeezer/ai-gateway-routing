import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '../api/classify';
import { BUDGET_TIER_MODELS, TIER_MODELS } from '../src/router';

/**
 * Contract tests for the public regex-only classification endpoint (GET/POST /api/classify).
 * The handler must be pure: classification only, no network, no model calls, no fetch.
 */

const BASE = 'https://example.com/api/classify';

function post(body: string): Promise<Response> {
  return handler(
    new Request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  );
}

function get(query: string): Promise<Response> {
  return handler(new Request(`${BASE}?${query}`));
}

interface ClassifyBody {
  error?: string;
  tier?: string;
  provider?: string;
  model?: string;
}

/** Response.json() is typed `unknown` under strict node types; narrow it once here. */
async function bodyOf(res: Response): Promise<ClassifyBody> {
  return (await res.json()) as ClassifyBody; // raw json() — do not route through bodyOf
}

function req(method: string, body?: string): Promise<Response> {
  return handler(
    new Request(BASE, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body,
    }),
  );
}

// Hygiene: the router reads these env vars; save/clear so tests are deterministic
// and never leak the caller's environment into assertions (and vice versa).
const ENV_KEYS = ['TIER_PROFILE', 'FAST_TIER_PROVIDER', 'LOCAL_LLM_MODEL'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
});

// The endpoint is regex-only classification: every handler invocation must run
// with fetch stubbed to throw, so ANY network attempt fails the test loudly.
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('classify endpoint must not perform network requests');
  });
});

describe('classification endpoint: rejected inputs', () => {
  it('rejects an invalid forceTier with 400 (GET)', async () => {
    const res = await get('prompt=hi&forceTier=bogus');
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.error).toMatch(/forceTier/i);
  });

  it('rejects an invalid forceTier with 400 (POST)', async () => {
    const res = await post(JSON.stringify({ prompt: 'hi', forceTier: 'ultra' }));
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.error).toMatch(/forceTier/i);
  });

  it('does not throw or reflect untrusted values in enum validation errors', async () => {
    for (const field of ['forceTier', 'fastProvider'] as const) {
      const value = { toString: null, secret: 'SENTINEL_PRIVATE_VALUE' };
      const res = await post(JSON.stringify({ prompt: 'hi', [field]: value }));
      expect(res.status).toBe(400);
      const body = await bodyOf(res);
      expect(body.error).toMatch(new RegExp(field));
      expect(JSON.stringify(body)).not.toContain('SENTINEL_PRIVATE_VALUE');
    }
  });

  it('rejects non-string forceTier instead of silently ignoring it', async () => {
    for (const value of [null, 42, {}, true]) {
      const res = await post(JSON.stringify({ prompt: 'hi', forceTier: value }));
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).error).toMatch(/forceTier/i);
    }
  });

  it('rejects non-string fastProvider instead of silently ignoring it', async () => {
    for (const value of [null, 42, {}, true]) {
      const res = await post(JSON.stringify({ prompt: 'hi', fastProvider: value }));
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).error).toMatch(/fastProvider/i);
    }
  });

  it('rejects ambiguous hasImages values instead of silently routing them as text', async () => {
    for (const value of [1, 'yes', null]) {
      const res = await post(JSON.stringify({ prompt: 'what is this?', hasImages: value }));
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).error).toMatch(/hasImages/i);
    }
  });

  it('accepts every valid forceTier enum value (200 with tier + model)', async () => {
    for (const tier of ['fast', 'reasoning', 'vision', 'coding'] as const) {
      const res = await post(JSON.stringify({ prompt: 'hi', forceTier: tier }));
      expect(res.status).toBe(200);
      const body = await bodyOf(res);
      expect(body.tier).toBe(tier);
      expect(typeof body.model).toBe('string');
      expect(body.model?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('rejects an unsupported fastProvider with 400 instead of silently ignoring it (POST)', async () => {
    const res = await post(JSON.stringify({ prompt: 'hi', fastProvider: 'mistral' }));
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.error).toMatch(/fastProvider/i);
  });

  it('rejects an unsupported fastProvider with 400 (GET)', async () => {
    const res = await get('prompt=hi&fastProvider=azure');
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.error).toMatch(/fastProvider/i);
  });

  it('rejects an images field with 400 and points at hasImages instead (POST)', async () => {
    const res = await post(
      JSON.stringify({ prompt: 'what is this?', images: ['https://x.test/y.png'] }),
    );
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.error).toMatch(/hasImages/i);
  });

  it('rejects a non-array images field with 400 (POST)', async () => {
    const res = await post(JSON.stringify({ prompt: 'what is this?', images: 'https://x.test/y.png' }));
    expect(res.status).toBe(400);
  });

  it('rejects an images query param with 400 (GET)', async () => {
    const res = await get('prompt=what+is+this&images=https://x.test/y.png');
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.error).toMatch(/hasImages/i);
  });

  it('returns 405 for unsupported methods', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const res = await req(method, JSON.stringify({ prompt: 'hi' }));
      expect(res.status).toBe(405);
    }
  });

  it('rejects malformed JSON body with 400', async () => {
    const res = await post('{"prompt": "hi" oops');
    expect(res.status).toBe(400);
  });

  it('rejects non-object JSON bodies with 400', async () => {
    for (const raw of ['[1,2,3]', '"just a string"', '42', 'null']) {
      const res = await post(raw);
      expect(res.status).toBe(400);
    }
  });

  it('returns 413 for an oversized prompt (POST)', async () => {
    const res = await post(JSON.stringify({ prompt: 'x'.repeat(10_001) }));
    expect(res.status).toBe(413);
  });

  it('returns 413 for an oversized prompt (GET URL)', async () => {
    const res = await get(`prompt=${'x'.repeat(10_001)}`);
    expect(res.status).toBe(413);
  });

  it('accepts a prompt at the size boundary (10_000 chars, 200)', async () => {
    const res = await post(JSON.stringify({ prompt: 'a'.repeat(10_000) }));
    expect(res.status).toBe(200);
  });

  it('still rejects a missing prompt with 400 (existing behavior)', async () => {
    expect((await post('{}')).status).toBe(400);
    expect((await get('')).status).toBe(400);
  });
});

describe('classification endpoint: routing matches the actual routed model', () => {
  it('TIER_PROFILE=budget returns the budget profile model for a gateway tier', async () => {
    process.env.TIER_PROFILE = 'budget';
    const res = await post(JSON.stringify({ prompt: 'Analyze the trade-offs step by step.' }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.tier).toBe('reasoning');
    expect(body.provider).toBe('gateway');
    expect(body.model).toBe(BUDGET_TIER_MODELS.reasoning);
  });

  it('default profile returns the quality model for a gateway tier', async () => {
    const res = await post(JSON.stringify({ prompt: 'Analyze the trade-offs step by step.' }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.tier).toBe('reasoning');
    expect(body.provider).toBe('gateway');
    expect(body.model).toBe(TIER_MODELS.reasoning);
  });

  it('FAST_TIER_PROVIDER=local returns the local model, not the openrouter/gateway one', async () => {
    process.env.FAST_TIER_PROVIDER = 'local';
    process.env.LOCAL_LLM_MODEL = 'test-local-model';
    const res = await post(JSON.stringify({ prompt: 'Capital of France?' }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.tier).toBe('fast');
    expect(body.provider).toBe('local');
    expect(body.model).toBe('test-local-model');
  });

  it('per-request fastProvider=local returns the local model', async () => {
    process.env.LOCAL_LLM_MODEL = 'test-local-model';
    const res = await post(JSON.stringify({ prompt: 'Capital of France?', fastProvider: 'local' }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.provider).toBe('local');
    expect(body.model).toBe('test-local-model');
  });

  it('fastProvider=gateway returns the profile-aware gateway fast model', async () => {
    process.env.TIER_PROFILE = 'budget';
    const res = await post(JSON.stringify({ prompt: 'Capital of France?', fastProvider: 'gateway' }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.provider).toBe('gateway');
    expect(body.model).toBe(BUDGET_TIER_MODELS.fast);
  });

  it('fastProvider=openrouter returns the auto router model', async () => {
    const res = await get('prompt=Capital+of+France%3F&fastProvider=openrouter');
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.provider).toBe('openrouter');
    expect(body.model).toBe('openrouter/auto');
  });

  it('hasImages=true routes to vision (POST boolean, GET string — existing behavior)', async () => {
    const postRes = await post(JSON.stringify({ prompt: 'what is this?', hasImages: true }));
    expect(postRes.status).toBe(200);
    expect((await bodyOf(postRes)).tier).toBe('vision');

    const getRes = await get('prompt=what+is+this&hasImages=true');
    expect(getRes.status).toBe(200);
    expect((await bodyOf(getRes)).tier).toBe('vision');
  });
});