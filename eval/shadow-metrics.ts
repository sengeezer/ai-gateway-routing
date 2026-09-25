/**
 * Metrics core for the offline-first shadow comparison harness.
 *
 * Pure, dependency-free functions over result rows. No classifier, no network,
 * no filesystem — so they are trivially testable and reusable by any caller.
 *
 * DESIGN RULES (do not violate):
 *   - A comparator's raw similarity (e.g. embedding cosine) is NEVER a confidence.
 *     Only an explicit calibrated probability distribution (`probabilities`) feeds
 *     calibration/Brier; only an explicit `confidence` feeds selective reporting.
 *   - Abstention and errors are first-class pseudo-predictions ('abstain' /
 *     'error'): they count as *incorrect* tier predictions, never omitted.
 *   - Label accuracy is task-type routing agreement. It does NOT measure response
 *     quality; no report here should be read that way.
 */

import type { TaskTier } from '../src/router';

/** The four routable tiers, in canonical order. */
export const TIERS: readonly TaskTier[] = ['fast', 'reasoning', 'vision', 'coding'];

/** Prediction labels: the four tiers plus the two pseudo-predictions. */
export const PREDICTION_LABELS = [...TIERS, 'abstain', 'error'] as const;
export type PredictionLabel = TaskTier | 'abstain' | 'error';

/** A single comparator's outcome for one case, as recorded on a result row. */
export interface ScoredCell {
  status: 'ok' | 'error';
  /** `null` when the comparator produced no tier (an error). */
  tier: TaskTier | 'abstain' | null;
  /** Calibrated confidence in [0,1] when the comparator supplies one; else `null`. */
  confidence: number | null;
  /** Distinguishes a model judgment from a deterministic image/forced-tier rule. */
  decisionSource?: 'model' | 'rule';
  /** Actual model ID/version, if the provider reported one. */
  modelVersion?: string;
  /** Execution transport, not inferred from the model name. */
  transport?: 'direct' | 'gateway';
  /** Token usage reported by the provider; not an actual cost. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Full distribution when the comparator supplies one; else absent. */
  probabilities?: Record<string, number> | null;
  /** Structured failure code when `status === 'error'`; else `null`. */
  errorCode: string | null;
  /** Wall-clock milliseconds for this comparator on this case. */
  elapsedMs: number;
}

/** Structural row shape the metrics consume. `ShadowRow` satisfies it. */
export interface MetricsRow {
  id: string;
  /** Provisional (or adjudicated) reference tier. */
  expected: TaskTier;
  subtype: string;
  split: string;
  adversarial?: boolean;
  ambiguous?: boolean;
  predictions: Partial<Record<string, ScoredCell>>;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Collapse a cell to its scoring label. Errors and missing tiers become 'error'. */
export function predictionLabel(cell: ScoredCell | undefined): PredictionLabel {
  if (!cell || cell.status === 'error' || cell.tier === null) return 'error';
  return cell.tier;
}

/** Linear-interpolated quantile (numpy-style) over an unsorted sample. */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Lower bound of the Wilson score interval for a binomial proportion.
 * A conservative floor on an accuracy estimate given its sample size — the
 * honest way to report "accuracy with sample counts".
 */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = successes / total;
  const z2 = z * z;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return Math.max(0, (centre - margin) / (1 + z2 / total));
}

function cellOf(row: MetricsRow, comparator: string): ScoredCell | undefined {
  return row.predictions[comparator];
}

function correctCount(rows: MetricsRow[], comparator: string): number {
  return rows.filter((r) => predictionLabel(cellOf(r, comparator)) === r.expected).length;
}

// ---------------------------------------------------------------------------
// Accuracy
// ---------------------------------------------------------------------------

export interface AccuracyReport {
  correct: number;
  total: number;
  accuracy: number;
  /** Wilson 95% lower bound on accuracy. */
  wilsonLower: number;
}

export function accuracyReport(rows: MetricsRow[], comparator: string): AccuracyReport {
  const correct = correctCount(rows, comparator);
  const total = rows.length;
  return {
    correct,
    total,
    accuracy: total ? correct / total : 0,
    wilsonLower: wilsonLowerBound(correct, total),
  };
}

// ---------------------------------------------------------------------------
// Confusion matrix + per-class / macro metrics
// ---------------------------------------------------------------------------

export interface ConfusionReport {
  labels: string[];
  /** matrix[expected][predicted] = count. */
  matrix: Record<string, Record<string, number>>;
}

export function confusion(rows: MetricsRow[], comparator: string): ConfusionReport {
  const labels: string[] = [...PREDICTION_LABELS];
  const matrix: Record<string, Record<string, number>> = {};
  for (const expected of labels) {
    matrix[expected] = {};
    for (const predicted of labels) matrix[expected][predicted] = 0;
  }
  for (const row of rows) {
    const predicted = predictionLabel(cellOf(row, comparator));
    matrix[row.expected][predicted] = (matrix[row.expected][predicted] ?? 0) + 1;
  }
  return { labels, matrix };
}

export interface ClassMetrics {
  label: TaskTier;
  precision: number;
  recall: number;
  f1: number;
  /** Number of cases whose reference label is this tier. */
  support: number;
  /** Number of cases predicted as this tier. */
  predicted: number;
}

export interface MacroReport {
  perClass: ClassMetrics[];
  macroPrecision: number;
  macroRecall: number;
  macroF1: number;
}

/** Per-class precision/recall/F1 for the four tiers, then their macro average. */
export function macroReport(rows: MetricsRow[], comparator: string): MacroReport {
  const perClass: ClassMetrics[] = TIERS.map((label) => {
    const support = rows.filter((r) => r.expected === label).length;
    const predicted = rows.filter((r) => predictionLabel(cellOf(r, comparator)) === label).length;
    const truePositive = rows.filter(
      (r) => r.expected === label && predictionLabel(cellOf(r, comparator)) === label,
    ).length;
    const precision = predicted ? truePositive / predicted : 0;
    const recall = support ? truePositive / support : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { label, precision, recall, f1, support, predicted };
  });

  // Macro averages over classes that actually occur in the reference labels.
  const present = perClass.filter((c) => c.support > 0);
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    perClass,
    macroPrecision: mean(present.map((c) => c.precision)),
    macroRecall: mean(present.map((c) => c.recall)),
    macroF1: mean(present.map((c) => c.f1)),
  };
}

// ---------------------------------------------------------------------------
// Selective prediction (confidence-gated accuracy/coverage)
// ---------------------------------------------------------------------------

export interface SelectivePoint {
  threshold: number;
  /** Cases kept at this threshold. */
  selected: number;
  coverage: number;
  selectiveAccuracy: number;
  /** Wilson 95% lower bound on the selective accuracy. */
  wilsonLower: number;
}

export interface SelectiveReport {
  /** False when the comparator supplies no numeric confidence to gate on. */
  available: boolean;
  points: SelectivePoint[];
}

/**
 * Coverage/accuracy as confidence is gated upward. Only cells that carry a
 * finite confidence participate; abstain/error cells have no confidence and are
 * excluded from the gated set (they are not "selected").
 */
export function selectiveReport(
  rows: MetricsRow[],
  comparator: string,
  thresholds: number[],
): SelectiveReport {
  const scored = rows.filter((r) => {
    const c = cellOf(r, comparator);
    return !!c && c.status === 'ok' && c.decisionSource !== 'rule' && c.tier !== 'abstain' && typeof c.confidence === 'number' && Number.isFinite(c.confidence);
  });
  if (scored.length === 0) return { available: false, points: [] };

  const points = thresholds.map((threshold) => {
    const kept = scored.filter(
      (r) => (cellOf(r, comparator)!.confidence as number) >= threshold,
    );
    const correct = kept.filter((r) => predictionLabel(cellOf(r, comparator)) === r.expected).length;
    return {
      threshold,
      selected: kept.length,
      coverage: rows.length ? kept.length / rows.length : 0,
      selectiveAccuracy: kept.length ? correct / kept.length : 0,
      wilsonLower: wilsonLowerBound(correct, kept.length),
    };
  });

  return { available: true, points };
}

// ---------------------------------------------------------------------------
// Calibration (only when a full distribution is supplied)
// ---------------------------------------------------------------------------

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  meanConfidence: number;
  accuracy: number;
  /** |meanConfidence - accuracy| for the bin. */
  gap: number;
}

export interface CalibrationReport {
  /** Rows contributing a usable distribution + expected tier inside its support. */
  n: number;
  bins: CalibrationBin[];
  /** Multiclass Brier score, or null when no row supplied probabilities. */
  brier: number | null;
  /** Expected calibration error over the confidence bins, or null. */
  ece: number | null;
}

/**
 * Reliability bins + multiclass Brier over rows that supply a full probability
 * distribution whose option set contains the reference tier. Raw similarity
 * scores are deliberately not accepted here.
 */
export function calibrationReport(
  rows: MetricsRow[],
  comparator: string,
  binCount = 10,
): CalibrationReport {
  const usable: { confidence: number; correct: boolean; options: string[]; probs: Record<string, number>; expected: string }[] = [];

  for (const row of rows) {
    const cell = cellOf(row, comparator);
    const probs = cell?.probabilities;
    if (!cell || cell.status !== 'ok' || cell.decisionSource === 'rule' || !probs) continue;
    const options = Object.keys(probs);
    if (options.length === 0) continue;
    if (options.some((k) => typeof probs[k] !== 'number' || !Number.isFinite(probs[k]) || probs[k] < 0 || probs[k] > 1)) continue;
    const sum = options.reduce((total, key) => total + probs[key], 0);
    if (Math.abs(sum - 1) > 1e-6) continue;
    if (!options.includes(row.expected)) continue; // expected not in the model's support
    const top = Math.max(...options.map((k) => probs[k]));
    usable.push({
      confidence: top,
      correct: predictionLabel(cell) === row.expected,
      options,
      probs,
      expected: row.expected,
    });
  }

  const bins: CalibrationBin[] = [];
  const size = Math.max(1, binCount);
  for (let i = 0; i < size; i++) {
    const lo = i / size;
    const hi = (i + 1) / size;
    const inBin = usable.filter(
      (u) => u.confidence >= lo && (i === size - 1 ? u.confidence <= hi : u.confidence < hi),
    );
    const n = inBin.length;
    const meanConfidence = n ? inBin.reduce((a, u) => a + u.confidence, 0) / n : 0;
    const accuracy = n ? inBin.filter((u) => u.correct).length / n : 0;
    bins.push({ lo, hi, n, meanConfidence, accuracy, gap: Math.abs(meanConfidence - accuracy) });
  }

  if (usable.length === 0) return { n: 0, bins, brier: null, ece: null };

  let brier = 0;
  for (const u of usable) {
    let sq = 0;
    for (const option of u.options) {
      const y = option === u.expected ? 1 : 0;
      const diff = u.probs[option] - y;
      sq += diff * diff;
    }
    brier += sq;
  }
  brier /= usable.length;

  const ece = bins.reduce((a, b) => a + (b.n / usable.length) * b.gap, 0);

  return { n: usable.length, bins, brier, ece };
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

export interface LatencyReport {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

/** Latency percentiles over every recorded cell (including failures). */
export function latencyReport(rows: MetricsRow[], comparator: string): LatencyReport {
  const values: number[] = [];
  for (const row of rows) {
    const cell = cellOf(row, comparator);
    if (cell && typeof cell.elapsedMs === 'number' && Number.isFinite(cell.elapsedMs)) {
      values.push(cell.elapsedMs);
    }
  }
  return {
    n: values.length,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: values.length ? Math.max(...values) : NaN,
  };
}
