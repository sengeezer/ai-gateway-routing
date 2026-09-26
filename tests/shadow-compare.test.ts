/**
 * Tests for the three-way shadow comparison harness (eval/shadow-compare.ts).
 *
 * Hermetic + offline: every classifier is injected, so no test touches the
 * network, credentials, or the pilot/held-out dataset. The holdout precondition
 * is exercised through an injected file reader and env, never the real FS.
 */
import { describe, it, expect } from 'vitest';
import type { RouteInput, TaskTier } from '../src/router';
import type { PilotCase } from '../eval/pilot-dataset';
import {
  COMPARATOR_NAMES,
  buildReport,
  embeddingsComparator,
  jevComparator,
  parseArgs,
  planRun,
  regexComparator,
  resolveHoldout,
  runShadowComparison,
  type ComparatorOutcome,
  type JevResultLike,
} from '../eval/shadow-compare';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const pilotCase = (
  id: string,
  expected: TaskTier,
  split: PilotCase['split'] = 'validation',
  extra: Partial<PilotCase> = {},
): PilotCase => ({
  id,
  expected,
  subtype: 'short-factual',
  split,
  prompt: `prompt for ${id}`,
  ...extra,
});

const outcome = (partial: Partial<ComparatorOutcome> = {}): ComparatorOutcome => ({
  status: 'ok',
  tier: 'fast',
  confidence: null,
  ...partial,
});

const okCmp = (tier: TaskTier | 'abstain'): ComparatorOutcome =>
  outcome({ status: 'ok', tier, confidence: null });

/** A deterministic monotonic clock: each call advances by 5ms. */
function stepClock(): () => number {
  let t = 0;
  return () => (t += 5);
}

// ---------------------------------------------------------------------------
// core harness
// ---------------------------------------------------------------------------

describe('runShadowComparison', () => {
  it('records a prediction cell per (case, comparator) and counts no failures', async () => {
    const run = await runShadowComparison({
      cases: [pilotCase('a', 'fast'), pilotCase('b', 'coding')],
      comparators: {
        regex: (i) => okCmp(i.prompt.includes('b') ? 'coding' : 'fast'),
        jev: () => okCmp('reasoning'),
      },
    });

    expect(run.rows).toHaveLength(2);
    expect(run.rows[0].predictions.regex?.tier).toBe('fast');
    expect(run.rows[0].predictions.jev?.tier).toBe('reasoning');
    expect(run.rows[1].predictions.regex?.tier).toBe('coding');
    expect(run.failures.regex ?? 0).toBe(0);
    expect(run.failures.jev ?? 0).toBe(0);
    expect(run.comparators).toEqual(['regex', 'jev']);
  });

  it('preserves row metadata (id, provisional expected, subtype, split)', async () => {
    const run = await runShadowComparison({
      cases: [pilotCase('pf-x-01', 'vision', 'holdout', { subtype: 'vision' })],
      comparators: { regex: () => okCmp('vision') },
    });
    const row = run.rows[0];
    expect(row.id).toBe('pf-x-01');
    expect(row.expected).toBe('vision');
    expect(row.subtype).toBe('vision');
    expect(row.split).toBe('holdout');
  });

  it('records elapsedMs from the injected clock per comparator', async () => {
    const run = await runShadowComparison({
      cases: [pilotCase('a', 'fast')],
      comparators: { regex: () => okCmp('fast') },
      clock: stepClock(),
    });
    expect(run.rows[0].predictions.regex?.elapsedMs).toBe(5);
  });

  it('counts a throwing comparator as a failure and still emits the row', async () => {
    const run = await runShadowComparison({
      cases: [pilotCase('a', 'fast')],
      comparators: {
        regex: () => okCmp('fast'),
        embeddings: () => {
          throw new Error('network down');
        },
      },
    });

    expect(run.rows).toHaveLength(1);
    const cell = run.rows[0].predictions.embeddings!;
    expect(cell.status).toBe('error');
    expect(cell.tier).toBeNull();
    expect(cell.errorCode).toBeTruthy();
    expect(run.failures.embeddings).toBe(1);
  });

  it('uses a structured error code when the thrown error carries one', async () => {
    const run = await runShadowComparison({
      cases: [pilotCase('a', 'fast')],
      comparators: {
        embeddings: () => {
          const e = new Error('boom') as Error & { code?: string };
          e.code = 'transport';
          throw e;
        },
      },
    });
    expect(run.rows[0].predictions.embeddings?.errorCode).toBe('transport');
  });

  it('counts every failure, never dropping or silently omitting a case', async () => {
    const cases = [pilotCase('a', 'fast'), pilotCase('b', 'fast'), pilotCase('c', 'fast')];
    const run = await runShadowComparison({
      cases,
      comparators: {
        jev: () => {
          throw new Error('nope');
        },
      },
    });
    expect(run.rows).toHaveLength(3);
    expect(run.failures.jev).toBe(3);
    expect(run.rows.every((r) => r.predictions.jev?.status === 'error')).toBe(true);
  });

  it('rejects an empty comparator set (a run must compare something)', async () => {
    await expect(
      runShadowComparison({ cases: [pilotCase('a', 'fast')], comparators: {} }),
    ).rejects.toThrow();
  });

  it('does not carry prompt text onto result rows (no routine prompt logging)', async () => {
    const run = await runShadowComparison({
      cases: [pilotCase('a', 'fast')],
      comparators: { regex: () => okCmp('fast') },
    });
    expect(Object.prototype.hasOwnProperty.call(run.rows[0], 'prompt')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// comparator adapters
// ---------------------------------------------------------------------------

describe('regexComparator', () => {
  it('classifies locally and offline with no confidence claim', async () => {
    const cmp = regexComparator();
    const code = await cmp({ prompt: 'write a function that reverses a string' });
    expect(code.tier).toBe('coding');
    expect(code.confidence).toBeNull();
    const fast = await cmp({ prompt: 'what is the capital of Spain' });
    expect(fast.tier).toBe('fast');
  });
});

describe('embeddingsComparator', () => {
  it('never exposes the raw embedding cosine as confidence', async () => {
    const cmp = embeddingsComparator({
      // Injected: a detailed result carrying a very high cosine score.
      classifyDetailed: async (_i: RouteInput) => ({ tier: 'coding' as const, score: 0.97 }),
    });
    const result = await cmp({ prompt: 'how do I parse JSON in python' });
    expect(result.tier).toBe('coding');
    expect(result.confidence).toBeNull();
    expect(result.probabilities ?? null).toBeNull();
  });

  it('reports a structured error when the embeddings call throws', async () => {
    const cmp = embeddingsComparator({
      classifyDetailed: async () => {
        throw new Error('no ai gateway key');
      },
    });
    // The adapter itself surfaces the failure as an error outcome.
    const result = await cmp({ prompt: 'x' });
    expect(result.status).toBe('error');
    expect(result.errorCode).toBeTruthy();
  });
});

describe('jevComparator', () => {
  const jevOk: JevResultLike = {
    tier: 'reasoning',
    confidence: 0.71,
    probabilities: { fast: 0.1, reasoning: 0.7, coding: 0.15, abstain: 0.05 },
    latencyMs: 12,
  };

  it('passes through tier, confidence and the full probability distribution', async () => {
    const cmp = jevComparator({ classify: async () => jevOk });
    const result = await cmp({ prompt: 'weigh the tradeoffs of remote work' });
    expect(result.status).toBe('ok');
    expect(result.tier).toBe('reasoning');
    expect(result.confidence).toBeCloseTo(0.71, 10);
    expect(result.probabilities).toEqual(jevOk.probabilities);
  });

  it('treats a model abstain (no error) as a decision, not a failure', async () => {
    const cmp = jevComparator({
      classify: async () => ({
        tier: 'abstain',
        confidence: 0.4,
        probabilities: { fast: 0.2, reasoning: 0.2, coding: 0.2, abstain: 0.4 },
      }),
    });
    const result = await cmp({ prompt: 'make it better' });
    expect(result.status).toBe('ok');
    expect(result.tier).toBe('abstain');
  });

  it('reports a transport failure as a structured error with its kind', async () => {
    const cmp = jevComparator({
      classify: async () => ({
        tier: 'abstain',
        confidence: 0,
        probabilities: { fast: 0, reasoning: 0, coding: 0, abstain: 1 },
        error: { kind: 'timeout', message: 'exceeded budget' },
      }),
    });
    const result = await cmp({ prompt: 'x' });
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('timeout');
    expect(result.tier).toBeNull();
  });

  it('carries model metadata into the saved report row', async () => {
    const cmp = jevComparator({
      classify: async () => ({
        ...jevOk,
        modelVersion: 'typesafe-ai/jev',
        usage: { inputTokens: 120, outputTokens: 8 },
        transport: 'gateway',
      }),
    });
    const run = await runShadowComparison({
      cases: [pilotCase('metadata', 'reasoning')],
      comparators: { jev: cmp },
    });
    const cell = run.rows[0].predictions.jev;
    expect(cell?.modelVersion).toBe('typesafe-ai/jev');
    expect(cell?.usage?.inputTokens).toBe(120);
    expect(cell?.transport).toBe('gateway');
    const report = buildReport(run, parseArgs([]), ['validation']);
    expect(report.reports[0].accuracy.correct).toBe(1);
  });

  it('preserves Jev model/version, usage and transport as report metadata', async () => {
    const cmp = jevComparator({
      classify: async () => ({
        ...jevOk,
        modelVersion: 'typesafe-ai/jev',
        usage: { inputTokens: 120, outputTokens: 8 },
        transport: 'gateway',
      }),
    });
    const result = await cmp({ prompt: 'analyze this' });
    expect(result.modelVersion).toBe('typesafe-ai/jev');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 8 });
    expect(result.transport).toBe('gateway');
  });

  it('maps a locally short-circuited (image) decision to the vision tier', async () => {
    const cmp = jevComparator({
      classify: async () => ({
        tier: 'vision' as const,
        confidence: 1,
        probabilities: { fast: 0, reasoning: 0, coding: 0, abstain: 0 },
        shortCircuit: 'images',
      }),
    });
    const result = await cmp({ prompt: 'describe this', images: ['data:image/png;base64,AA'] });
    expect(result.status).toBe('ok');
    expect(result.tier).toBe('vision');
    expect(result.decisionSource).toBe('rule');
    expect(result.confidence).toBeNull();
    expect(result.probabilities).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLI argument parsing + holdout precondition
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('defaults to offline validation-only regex', () => {
    const o = parseArgs([]);
    expect(o.live).toBe(false);
    expect(o.holdout).toBe(false);
    expect(o.comparators).toBeNull();
    expect(o.json).toBe(false);
    expect(o.help).toBe(false);
  });

  it('parses --live, --holdout, --comparators, --json, --thresholds', () => {
    const o = parseArgs([
      '--live',
      '--holdout',
      '--json',
      '--comparators=regex,jev',
      '--thresholds=0.5,0.8',
    ]);
    expect(o.live).toBe(true);
    expect(o.holdout).toBe(true);
    expect(o.json).toBe(true);
    expect(o.comparators).toEqual(['regex', 'jev']);
    expect(o.thresholds).toEqual([0.5, 0.8]);
  });

  it('rejects an unknown comparator name', () => {
    expect(() => parseArgs(['--comparators=regex,nope'])).toThrow();
  });
});

describe('resolveHoldout', () => {
  it('allows the default (no holdout) without any precondition', () => {
    const d = resolveHoldout({ holdout: false, env: {}, readFile: () => '' });
    expect(d.ok).toBe(true);
  });

  it('refuses the holdout when no adjudicated-label artifact is available', () => {
    const d = resolveHoldout({
      holdout: true,
      env: {},
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/adjudicat/i);
  });

  it('refuses the holdout when the artifact exists but is not adjudicated', () => {
    const d = resolveHoldout({
      holdout: true,
      env: {},
      readFile: () => JSON.stringify({ adjudicated: false, labels: { x: 'fast' } }),
    });
    expect(d.ok).toBe(false);
  });

  it('allows the holdout only with an adjudicated-label artifact', () => {
    const d = resolveHoldout({
      holdout: true,
      env: {},
      readFile: () =>
        JSON.stringify({ adjudicated: true, labels: { 'pf-x-01': 'coding' } }),
    });
    expect(d.ok).toBe(true);
    expect(d.labels).toEqual({ 'pf-x-01': 'coding' });
  });

  it('honours the SHADOW_HOLDOUT_ADJUDICATED path override', () => {
    let seenPath = '';
    const d = resolveHoldout({
      holdout: true,
      env: { SHADOW_HOLDOUT_ADJUDICATED: '/tmp/adj.json' },
      readFile: (p) => {
        seenPath = p;
        return JSON.stringify({ adjudicated: true, labels: { a: 'fast' } });
      },
    });
    expect(d.ok).toBe(true);
    expect(seenPath).toBe('/tmp/adj.json');
  });
});

describe('planRun', () => {
  const cases = [
    pilotCase('v1', 'fast', 'validation'),
    pilotCase('h1', 'coding', 'holdout'),
  ];

  it('defaults to validation only and never surfaces holdout cases', () => {
    const plan = planRun(cases, parseArgs([]));
    expect(plan.ok).toBe(true);
    expect(plan.cases.map((c) => c.id)).toEqual(['v1']);
    expect(plan.splits).toEqual(['validation']);
  });

  it('refuses the holdout when the adjudication precondition is unavailable', () => {
    const plan = planRun(cases, parseArgs(['--holdout']), {
      env: {},
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/adjudicat/i);
  });

  it('includes holdout cases only when adjudicated, replacing their provisional labels', () => {
    const plan = planRun(cases, parseArgs(['--holdout']), {
      env: {},
      readFile: () => JSON.stringify({ adjudicated: true, labels: { h1: 'reasoning' } }),
    });
    expect(plan.ok).toBe(true);
    expect(plan.splits).toEqual(['validation', 'holdout']);
    const h = plan.cases.find((c) => c.id === 'h1');
    expect(h?.expected).toBe('reasoning');
    expect(h?.labelSource).toBe('adjudicated');
  });
});

describe('COMPARATOR_NAMES', () => {
  it('names the three-way comparison', () => {
    expect(COMPARATOR_NAMES).toEqual(['regex', 'embeddings', 'jev']);
  });
});
