/**
 * Tests for the shadow-comparison metrics core (eval/shadow-metrics.ts).
 *
 * Hermetic + offline: metrics are pure functions over synthetic rows, no
 * classifier, no network, no dataset.
 */
import { describe, it, expect } from 'vitest';
import {
  TIERS,
  accuracyReport,
  calibrationReport,
  confusion,
  latencyReport,
  macroReport,
  predictionLabel,
  quantile,
  selectiveReport,
  wilsonLowerBound,
  type MetricsRow,
  type ScoredCell,
} from '../eval/shadow-metrics';

const ok = (
  tier: ScoredCell['tier'],
  opts: Partial<ScoredCell> = {},
): ScoredCell => ({
  status: 'ok',
  tier,
  confidence: null,
  errorCode: null,
  elapsedMs: 1,
  ...opts,
});

const err = (code = 'transport', elapsedMs = 1): ScoredCell => ({
  status: 'error',
  tier: null,
  confidence: null,
  errorCode: code,
  elapsedMs,
});

const row = (
  id: string,
  expected: MetricsRow['expected'],
  cells: Record<string, ScoredCell>,
  extra: Partial<MetricsRow> = {},
): MetricsRow => ({
  id,
  expected,
  subtype: 'short-factual',
  split: 'validation',
  predictions: cells,
  ...extra,
});

describe('predictionLabel', () => {
  it('maps a tier prediction to that tier', () => {
    expect(predictionLabel(ok('coding'))).toBe('coding');
  });
  it('maps abstain to the abstain pseudo-label', () => {
    expect(predictionLabel(ok('abstain'))).toBe('abstain');
  });
  it('maps errors and missing tiers to the error pseudo-label', () => {
    expect(predictionLabel(err())).toBe('error');
    expect(predictionLabel(ok(null))).toBe('error');
  });
});

describe('accuracyReport', () => {
  const rows = [
    row('a', 'fast', { m: ok('fast') }),
    row('b', 'coding', { m: ok('coding') }),
    row('c', 'reasoning', { m: ok('coding') }),
  ];

  it('reports correct/total counts and accuracy', () => {
    const r = accuracyReport(rows, 'm');
    expect(r.correct).toBe(2);
    expect(r.total).toBe(3);
    expect(r.accuracy).toBeCloseTo(2 / 3, 10);
  });

  it('carries a Wilson lower bound strictly below the point estimate', () => {
    const r = accuracyReport(rows, 'm');
    expect(r.wilsonLower).toBeGreaterThan(0);
    expect(r.wilsonLower).toBeLessThan(r.accuracy);
  });

  it('counts abstain and error pseudo-predictions as incorrect', () => {
    const r = accuracyReport(
      [
        row('a', 'fast', { m: ok('abstain') }),
        row('b', 'fast', { m: err() }),
      ],
      'm',
    );
    expect(r.correct).toBe(0);
    expect(r.accuracy).toBe(0);
  });

  it('handles an empty selection without dividing by zero', () => {
    const r = accuracyReport([], 'm');
    expect(r.total).toBe(0);
    expect(r.accuracy).toBe(0);
    expect(r.wilsonLower).toBe(0);
  });
});

describe('wilsonLowerBound', () => {
  it('is below the point estimate for small samples', () => {
    expect(wilsonLowerBound(5, 10)).toBeLessThan(0.5);
    expect(wilsonLowerBound(5, 10)).toBeGreaterThan(0);
  });
  it('stays below 1 even at a perfect score and rises with n', () => {
    const small = wilsonLowerBound(10, 10);
    const large = wilsonLowerBound(100, 100);
    expect(small).toBeLessThan(1);
    expect(large).toBeLessThan(1);
    expect(large).toBeGreaterThan(small);
  });
  it('returns 0 for a zero denominator', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
});

describe('confusion + macroReport', () => {
  const rows = [
    row('a', 'fast', { m: ok('fast') }),
    row('b', 'fast', { m: ok('coding') }),
    row('c', 'coding', { m: ok('coding') }),
    row('d', 'reasoning', { m: ok('abstain') }),
  ];

  it('counts expected x predicted including pseudo-labels', () => {
    const { matrix } = confusion(rows, 'm');
    expect(matrix.fast.fast).toBe(1);
    expect(matrix.fast.coding).toBe(1);
    expect(matrix.coding.coding).toBe(1);
    expect(matrix.reasoning.abstain).toBe(1);
  });

  it('reports per-class precision/recall/F1 and a support-weighted view', () => {
    const report = macroReport(rows, 'm');
    const fast = report.perClass.find((c) => c.label === 'fast')!;
    const coding = report.perClass.find((c) => c.label === 'coding')!;
    expect(fast.support).toBe(2);
    expect(fast.recall).toBeCloseTo(0.5, 10);
    expect(fast.precision).toBe(1);
    expect(coding.support).toBe(1);
    expect(coding.recall).toBe(1);
    expect(coding.precision).toBeCloseTo(1 / 2, 10);
    // macro averages only over classes with support
    expect(report.macroF1).toBeGreaterThan(0);
    expect(report.macroF1).toBeLessThanOrEqual(1);
  });

  it('gives macro-F1 1 for perfectly separated predictions', () => {
    const report = macroReport(
      [
        row('a', 'fast', { m: ok('fast') }),
        row('b', 'coding', { m: ok('coding') }),
      ],
      'm',
    );
    expect(report.macroF1).toBe(1);
  });

  it('lists every tier as a confusion row', () => {
    const { labels } = confusion(rows, 'm');
    for (const t of TIERS) expect(labels).toContain(t);
    expect(labels).toContain('abstain');
    expect(labels).toContain('error');
  });
});

describe('selectiveReport', () => {
  const rows = [
    row('a', 'fast', { m: ok('fast', { confidence: 0.95 }) }),
    row('b', 'coding', { m: ok('coding', { confidence: 0.55 }) }),
    row('c', 'reasoning', { m: ok('coding', { confidence: 0.55 }) }),
    row('d', 'fast', { m: ok('fast', { confidence: 0.2 }) }),
  ];

  it('reports coverage and selective accuracy per threshold', () => {
    const report = selectiveReport(rows, 'm', [0.9, 0.5, 0.1]);
    const at90 = report.points.find((p) => p.threshold === 0.9)!;
    const at50 = report.points.find((p) => p.threshold === 0.5)!;
    const at10 = report.points.find((p) => p.threshold === 0.1)!;

    expect(at90.selected).toBe(1);
    expect(at90.coverage).toBeCloseTo(0.25, 10);
    expect(at90.selectiveAccuracy).toBe(1);

    expect(at50.selected).toBe(3);
    expect(at50.coverage).toBeCloseTo(0.75, 10);
    expect(at50.selectiveAccuracy).toBeCloseTo(2 / 3, 10);

    expect(at10.selected).toBe(4);
    expect(at10.coverage).toBe(1);
  });

  it('reports the Wilson lower bound on selective accuracy, never above the point estimate', () => {
    const report = selectiveReport(rows, 'm', [0.5]);
    const at50 = report.points[0];
    expect(at50.wilsonLower).toBeGreaterThan(0);
    expect(at50.wilsonLower).toBeLessThanOrEqual(at50.selectiveAccuracy);
  });

  it('excludes a deterministic override and model abstention from confidence-gated selection', () => {
    const report = selectiveReport(
      [
        row('rule', 'vision', { m: ok('vision', { confidence: 1, decisionSource: 'rule' }) }),
        row('abstain', 'fast', { m: ok('abstain', { confidence: 0.9, decisionSource: 'model' }) }),
        row('model', 'fast', { m: ok('fast', { confidence: 0.8, decisionSource: 'model' }) }),
      ],
      'm',
      [0.7],
    );
    expect(report.points[0].selected).toBe(1);
    expect(report.points[0].coverage).toBeCloseTo(1 / 3);
  });

  it('is unavailable when no comparator confidence is present', () => {
    const report = selectiveReport(
      [row('a', 'fast', { m: ok('fast') })],
      'm',
      [0.5],
    );
    expect(report.available).toBe(false);
    expect(report.points).toEqual([]);
  });
});

describe('calibrationReport', () => {
  it('computes multiclass Brier over the supplied probability options', () => {
    const rows = [
      row('a', 'fast', {
        m: ok('fast', {
          confidence: 0.9,
          probabilities: { fast: 0.9, reasoning: 0.05, coding: 0.05 },
        }),
      }),
      row('b', 'reasoning', {
        m: ok('fast', {
          confidence: 0.6,
          probabilities: { fast: 0.6, reasoning: 0.4, coding: 0 },
        }),
      }),
    ];
    const report = calibrationReport(rows, 'm', 5);
    expect(report.n).toBe(2);
    // (0.9-1)^2 + 0.05^2 + 0.05^2 = 0.015 ; 0.6^2 + (0.4-1)^2 + 0 = 0.72
    expect(report.brier).toBeCloseTo((0.015 + 0.72) / 2, 10);
    expect(report.bins.length).toBe(5);
    const totalInBins = report.bins.reduce((a, b) => a + b.n, 0);
    expect(totalInBins).toBe(2);
  });

  it('excludes deterministic rules and invalid distributions from model calibration', () => {
    const report = calibrationReport(
      [
        row('rule', 'fast', { m: ok('fast', { decisionSource: 'rule', confidence: 1, probabilities: { fast: 0, reasoning: 0, coding: 0, abstain: 0 } }) }),
        row('invalid', 'fast', { m: ok('fast', { decisionSource: 'model', confidence: 0.9, probabilities: { fast: 0.2, reasoning: 0.2, coding: 0.2, abstain: 0.2 } }) }),
        row('model', 'fast', { m: ok('fast', { decisionSource: 'model', confidence: 0.9, probabilities: { fast: 0.9, reasoning: 0.05, coding: 0.03, abstain: 0.02 } }) }),
      ],
      'm',
    );
    expect(report.n).toBe(1);
    expect(report.brier).not.toBeNull();
  });

  it('is unavailable (null Brier) when no full distributions are present', () => {
    const report = calibrationReport(
      [row('a', 'fast', { m: ok('fast', { confidence: 0.9 }) })],
      'm',
    );
    expect(report.brier).toBeNull();
    expect(report.n).toBe(0);
  });

  it('skips rows whose expected tier is not in the probability options', () => {
    const report = calibrationReport(
      [
        row('v', 'vision', {
          m: ok('vision', {
            confidence: 1,
            probabilities: { fast: 0.25, reasoning: 0.25, coding: 0.5 },
          }),
        }),
      ],
      'm',
    );
    expect(report.n).toBe(0);
  });
});

describe('latencyReport + quantile', () => {
  it('computes p50/p95 with linear interpolation', () => {
    const values = [1, 2, 3, 4, 100];
    expect(quantile(values, 0.5)).toBe(3);
    expect(quantile(values, 0.95)).toBeCloseTo(80.8, 10);
  });

  it('reports n, p50, p95 and max over all cells including errors', () => {
    const rows = [
      row('a', 'fast', { m: ok('fast', { elapsedMs: 10 }) }),
      row('b', 'fast', { m: ok('fast', { elapsedMs: 30 }) }),
      row('c', 'fast', { m: err('timeout', 1000) }),
    ];
    const report = latencyReport(rows, 'm');
    expect(report.n).toBe(3);
    expect(report.p50).toBe(30);
    expect(report.p95).toBeGreaterThanOrEqual(report.p50);
    expect(report.max).toBe(1000);
  });

  it('returns NaNs for an empty selection', () => {
    const report = latencyReport([], 'm');
    expect(report.n).toBe(0);
    expect(Number.isNaN(report.p50)).toBe(true);
  });
});
