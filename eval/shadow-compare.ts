/**
 * Three-way SHADOW comparison harness: regex vs. embeddings vs. Jev.
 *
 * OFFLINE-FIRST and OPT-IN. This module never makes a paid or network call by
 * itself. The CLI runs the pure local regex classifier by default; remote
 * comparators (embeddings, Jev) are only constructed when an explicit `--live`
 * flag AND the relevant credential are present. The harness core is pure and
 * takes injectable classifiers, so it is fully testable without credentials.
 *
 * SAFETY CONTRACT (enforced by design, not convention):
 *   - Validation split only by default. The holdout split is NEVER inspected
 *     unless `--holdout` is passed AND an adjudicated-label artifact exists;
 *     otherwise the run is refused (exit code 2) before any prediction is made.
 *   - Adjudicated holdout labels replace the provisional ones for scoring; a
 *     holdout case with no adjudicated label refuses the whole run.
 *   - Nothing is written to disk: no file output, so held-out predictions can
 *     never be edited or re-tuned between runs.
 *   - Result rows carry no prompt text, so routine output cannot leak prompts.
 *   - A comparator's raw similarity (e.g. embedding cosine) is NEVER a
 *     confidence. Only an explicit calibrated distribution feeds calibration.
 *   - Failures are COUNTED (per comparator), never silently omitted.
 *
 * Label accuracy is task-type ROUTING agreement against provisional (or
 * adjudicated) labels. It is not evidence of response quality; this harness
 * makes no such claim.
 *
 * Types shared with the metrics core live in `./shadow-metrics` to keep a single
 * direction of dependency (compare -> metrics) and avoid import cycles.
 *
 *   npx tsx eval/shadow-compare.ts                       # regex, validation only
 *   npx tsx eval/shadow-compare.ts --live                # + embeddings & Jev (needs keys)
 *   npx tsx eval/shadow-compare.ts --live --json
 *   npx tsx eval/shadow-compare.ts --holdout             # refused unless adjudicated
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { classify, type RouteInput, type TaskTier } from '../src/router';
import type { PilotCase, PilotSplit } from './pilot-dataset';
import {
  accuracyReport,
  calibrationReport,
  confusion,
  latencyReport,
  macroReport,
  predictionLabel,
  selectiveReport,
  TIERS,
  type MetricsRow,
  type ScoredCell,
} from './shadow-metrics';

// Re-export the metrics row types so callers can consume a ShadowRun and score it.
export type { ScoredCell, MetricsRow };

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export const COMPARATOR_NAMES = ['regex', 'embeddings', 'jev'] as const;
export type ComparatorName = (typeof COMPARATOR_NAMES)[number];

/** One comparator's raw outcome. `errorCode` is set only for failures. */
export interface ComparatorOutcome {
  status: 'ok' | 'error';
  tier: TaskTier | 'abstain' | null;
  confidence: number | null;
  decisionSource?: 'model' | 'rule';
  modelVersion?: string;
  transport?: 'direct' | 'gateway';
  usage?: { inputTokens: number; outputTokens: number };
  probabilities?: Record<string, number> | null;
  errorCode?: string | null;
}

export type ShadowClassifier = (input: RouteInput) => ComparatorOutcome | Promise<ComparatorOutcome>;

export interface ShadowRow extends MetricsRow {
  /** Marker of the reference-label provenance for this row. */
  labelSource: 'provisional' | 'adjudicated';
  predictions: Partial<Record<ComparatorName, ScoredCell>>;
}

export interface ShadowRun {
  rows: ShadowRow[];
  /** Comparators actually run, in canonical order. */
  comparators: ComparatorName[];
  /** Failure counts (error-status cells) per comparator. */
  failures: Partial<Record<ComparatorName, number>>;
}

export interface RunShadowOptions {
  cases: PilotCase[];
  comparators: Partial<Record<ComparatorName, ShadowClassifier>>;
  /** Injectable monotonic clock (defaults to `Date.now`). */
  clock?: () => number;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Normalize an unknown thrown value to a stable, non-secret error code. */
function errorCodeOf(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    const name = (err as { name?: unknown }).name;
    const message = String((err as { message?: unknown }).message ?? '');
    if (name === 'AbortError' || /abort/i.test(message)) return 'aborted';
    if (/timeout|ETIMEDOUT/i.test(message)) return 'timeout';
  }
  return 'unknown';
}

function toErrorCell(errorCode: string, elapsedMs: number): ScoredCell {
  return { status: 'error', tier: null, confidence: null, errorCode, elapsedMs };
}

/**
 * Run every case through every provided comparator. Never drops a case and never
 * swallows a failure: a throw (or an explicit error outcome) becomes an
 * error-status cell and increments that comparator's failure count.
 */
export async function runShadowComparison(options: RunShadowOptions): Promise<ShadowRun> {
  const clock = options.clock ?? (() => Date.now());
  const comparators = COMPARATOR_NAMES.filter((name) => options.comparators[name]);
  if (comparators.length === 0) {
    throw new Error('runShadowComparison: at least one comparator is required');
  }

  const failures: Partial<Record<ComparatorName, number>> = {};
  const rows: ShadowRow[] = [];

  for (const pilot of options.cases) {
    const predictions: Partial<Record<ComparatorName, ScoredCell>> = {};

    for (const name of comparators) {
      const classifier = options.comparators[name]!;
      const started = clock();
      let cell: ScoredCell;
      try {
        const outcome = await classifier(pilot);
        const elapsedMs = clock() - started;
        if (outcome.status === 'error') {
          cell = toErrorCell(outcome.errorCode ?? 'error', elapsedMs);
        } else {
          cell = {
            status: 'ok',
            tier: outcome.tier,
            confidence:
              typeof outcome.confidence === 'number' && Number.isFinite(outcome.confidence)
                ? outcome.confidence
                : null,
            probabilities: outcome.probabilities ?? null,
            decisionSource: outcome.decisionSource,
            modelVersion: outcome.modelVersion,
            transport: outcome.transport,
            usage: outcome.usage,
            errorCode: null,
            elapsedMs,
          };
        }
      } catch (err) {
        cell = toErrorCell(errorCodeOf(err), clock() - started);
      }

      if (cell.status === 'error') failures[name] = (failures[name] ?? 0) + 1;
      predictions[name] = cell;
    }

    rows.push({
      id: pilot.id,
      expected: pilot.expected,
      subtype: pilot.subtype,
      split: pilot.split,
      adversarial: pilot.adversarial ?? false,
      ambiguous: pilot.ambiguous ?? false,
      labelSource: (pilot as PilotCase & { labelSource?: 'provisional' | 'adjudicated' }).labelSource ?? 'provisional',
      predictions,
    });
  }

  return { rows, comparators, failures };
}

// ---------------------------------------------------------------------------
// Comparator adapters
// ---------------------------------------------------------------------------

/** Local regex classifier (the existing `classify`). Offline, deterministic, no confidence. */
export function regexComparator(): ShadowClassifier {
  return (input) => ({
    status: 'ok',
    tier: classify(input),
    confidence: null,
    probabilities: null,
    errorCode: null,
  });
}

export interface EmbeddingsDeps {
  /** Injected detailed classifier (tests). Defaults to a dynamic import. */
  classifyDetailed?: (input: RouteInput) => Promise<{ tier: TaskTier; score?: number; scores?: unknown }>;
}

/**
 * Embeddings comparator. Deliberately reports NO confidence: the cosine score is
 * a similarity, not a calibrated probability, and must never be presented as one.
 */
export function embeddingsComparator(deps: EmbeddingsDeps = {}): ShadowClassifier {
  return async (input) => {
    try {
      let detailed = deps.classifyDetailed;
      if (!detailed) {
        const mod = await import('../src/semantic-classifier');
        detailed = (i) => mod.classifySemanticDetailed(i);
      }
      const result = await detailed(input);
      // Note: `result.score` (cosine) is intentionally discarded — never confidence.
      return { status: 'ok', tier: result.tier, confidence: null, probabilities: null, errorCode: null };
    } catch (err) {
      return { status: 'error', tier: null, confidence: null, probabilities: null, errorCode: errorCodeOf(err) };
    }
  };
}

/** Structural shape of `JevClassification` this adapter consumes. */
export interface JevResultLike {
  tier: TaskTier | 'abstain';
  confidence: number;
  probabilities: Record<string, number>;
  error?: { kind: string; message: string };
  shortCircuit?: string;
  latencyMs?: number;
  modelVersion?: string;
  usage?: { inputTokens: number; outputTokens: number };
  transport?: 'direct' | 'gateway';
}

export interface JevDeps {
  /** Injected Jev classifier (tests). Defaults to a dynamic import of `classifyJev`. */
  classify?: (input: RouteInput) => Promise<JevResultLike>;
}

/**
 * Jev shadow comparator. A recorded adapter error (missing key, transport,
 * schema, timeout) becomes a counted failure with its `kind`; a model `abstain`
 * with no error is a decision, not a failure.
 */
export function jevComparator(deps: JevDeps = {}): ShadowClassifier {
  return async (input) => {
    try {
      let classifyJevFn = deps.classify;
      if (!classifyJevFn) {
        const mod = await import('../src/jev-classifier');
        classifyJevFn = (i) => mod.classifyJev(i);
      }
      const result = await classifyJevFn(input);
      if (result.error) {
        return {
          status: 'error',
          tier: null,
          confidence: null,
          probabilities: null,
          errorCode: result.error.kind || 'unknown',
        };
      }
      return {
        status: 'ok',
        tier: result.tier,
        decisionSource: result.shortCircuit ? 'rule' : 'model',
        confidence: result.shortCircuit ? null : typeof result.confidence === 'number' ? result.confidence : null,
        probabilities: result.shortCircuit ? null : result.probabilities ?? null,
        modelVersion: result.modelVersion,
        usage: result.usage,
        transport: result.transport ?? (result.shortCircuit ? undefined : (process.env.JEV_TRANSPORT?.trim().toLowerCase() === 'gateway' ? 'gateway' : 'direct')),
        errorCode: null,
      };
    } catch (err) {
      return { status: 'error', tier: null, confidence: null, probabilities: null, errorCode: errorCodeOf(err) };
    }
  };
}

// ---------------------------------------------------------------------------
// Holdout precondition
// ---------------------------------------------------------------------------

/** Default location of the adjudicated holdout labels. */
export const DEFAULT_ADJUDICATED_PATH = resolve(HERE, 'holdout-adjudicated.json');

const VALID_TIERS: readonly TaskTier[] = TIERS;

export interface HoldoutResolution {
  ok: boolean;
  /** Present on refusal: why the holdout cannot be used. */
  reason?: string;
  /** Present on success: adjudicated labels keyed by case id. */
  labels?: Record<string, TaskTier>;
  path: string;
}

export interface HoldoutDeps {
  holdout: boolean;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
}

/**
 * Resolve whether the holdout split may be used. Without `holdout: true` the
 * answer is trivially yes (validation-only). With it, an adjudicated-label
 * artifact must exist, parse, be flagged `adjudicated: true`, and map ids to
 * valid tiers — otherwise the resolution refuses.
 */
export function resolveHoldout(deps: HoldoutDeps): HoldoutResolution {
  const env = deps.env ?? (process.env as NodeJS.ProcessEnv);
  const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const override = env.SHADOW_HOLDOUT_ADJUDICATED;
  const path = override && override.trim().length > 0 ? override.trim() : DEFAULT_ADJUDICATED_PATH;

  if (!deps.holdout) return { ok: true, path };

  let raw: string;
  try {
    raw = read(path);
  } catch {
    return {
      ok: false,
      path,
      reason:
        `Holdout refused: no adjudicated-label artifact is available at ${path}. ` +
        'The holdout split is scored only against adjudicated (human-reviewed) labels; ' +
        'set SHADOW_HOLDOUT_ADJUDICATED to an adjudicated-labels file to proceed.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, path, reason: `Holdout refused: ${path} is not valid JSON.` };
  }

  if (!parsed || typeof parsed !== 'object' || (parsed as { adjudicated?: unknown }).adjudicated !== true) {
    return {
      ok: false,
      path,
      reason: `Holdout refused: ${path} does not declare adjudicated: true.`,
    };
  }

  const labelsRaw = (parsed as { labels?: unknown }).labels;
  if (!labelsRaw || typeof labelsRaw !== 'object' || Array.isArray(labelsRaw)) {
    return { ok: false, path, reason: `Holdout refused: ${path} has no labels object.` };
  }

  const labels: Record<string, TaskTier> = {};
  for (const [id, value] of Object.entries(labelsRaw as Record<string, unknown>)) {
    if (typeof value !== 'string' || !VALID_TIERS.includes(value as TaskTier)) {
      return {
        ok: false,
        path,
        reason: `Holdout refused: adjudicated label for "${id}" is not one of ${VALID_TIERS.join(', ')}.`,
      };
    }
    labels[id] = value as TaskTier;
  }

  return { ok: true, path, labels };
}

// ---------------------------------------------------------------------------
// CLI argument parsing + run planning
// ---------------------------------------------------------------------------

export interface CliOptions {
  live: boolean;
  holdout: boolean;
  comparators: ComparatorName[] | null;
  json: boolean;
  thresholds: number[];
  bins: number;
  help: boolean;
}

export const DEFAULT_THRESHOLDS = [0.5, 0.7, 0.9];

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    live: false,
    holdout: false,
    comparators: null,
    json: false,
    thresholds: [...DEFAULT_THRESHOLDS],
    bins: 10,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--live') options.live = true;
    else if (arg === '--holdout') options.holdout = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg.startsWith('--comparators=')) {
      const names = arg.slice('--comparators='.length).split(',').map((s) => s.trim()).filter(Boolean);
      for (const name of names) {
        if (!COMPARATOR_NAMES.includes(name as ComparatorName)) {
          throw new Error(`Unknown comparator "${name}". Known: ${COMPARATOR_NAMES.join(', ')}`);
        }
      }
      options.comparators = names as ComparatorName[];
    } else if (arg.startsWith('--thresholds=')) {
      const nums = arg.slice('--thresholds='.length).split(',').map((s) => Number(s.trim()));
      if (nums.length === 0 || nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
        throw new Error(`--thresholds must be a comma list of numbers in [0,1]`);
      }
      options.thresholds = nums;
    } else if (arg.startsWith('--bins=')) {
      const n = Number(arg.slice('--bins='.length));
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('--bins must be an integer in [1,100]');
      options.bins = n;
    } else {
      throw new Error(`Unknown argument "${arg}". Try --help.`);
    }
  }

  return options;
}

export interface PlannedCase extends PilotCase {
  labelSource: 'provisional' | 'adjudicated';
}

export interface RunPlan {
  ok: boolean;
  reason?: string;
  cases: PlannedCase[];
  splits: PilotSplit[];
  adjudicated: Record<string, TaskTier> | null;
  holdoutPath: string;
}

/**
 * Turn parsed options + the pilot cases into a concrete, split-safe plan.
 * Validation is always included; holdout only with an adjudicated artifact.
 */
export function planRun(
  cases: PilotCase[],
  options: CliOptions,
  deps: Omit<HoldoutDeps, 'holdout'> = {},
): RunPlan {
  const resolution = resolveHoldout({ holdout: options.holdout, env: deps.env, readFile: deps.readFile });
  if (!resolution.ok) {
    return {
      ok: false,
      reason: resolution.reason,
      cases: [],
      splits: [],
      adjudicated: null,
      holdoutPath: resolution.path,
    };
  }

  const validation = cases
    .filter((c) => c.split === 'validation')
    .map<PlannedCase>((c) => ({ ...c, labelSource: 'provisional' }));

  const splits: PilotSplit[] = ['validation'];
  const planned: PlannedCase[] = [...validation];
  const adjudicated = resolution.labels ?? null;

  if (options.holdout) {
    const holdout = cases.filter((c) => c.split === 'holdout');
    const missing = holdout.filter((c) => !adjudicated || !(c.id in adjudicated)).map((c) => c.id);
    if (missing.length > 0) {
      return {
        ok: false,
        reason:
          `Holdout refused: ${missing.length} holdout case(s) have no adjudicated label ` +
          `(e.g. ${missing.slice(0, 3).join(', ')}). Every held-out case must be adjudicated first.`,
        cases: [],
        splits: [],
        adjudicated,
        holdoutPath: resolution.path,
      };
    }
    splits.push('holdout');
    for (const c of holdout) {
      planned.push({ ...c, expected: adjudicated![c.id], labelSource: 'adjudicated' });
    }
  }

  return { ok: true, cases: planned, splits, adjudicated, holdoutPath: resolution.path };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const ms = (n: number): string => (Number.isFinite(n) ? `${n.toFixed(1)}ms` : 'n/a');

export interface ComparatorReport {
  comparator: ComparatorName;
  accuracy: ReturnType<typeof accuracyReport>;
  macro: ReturnType<typeof macroReport>;
  confusion: ReturnType<typeof confusion>;
  latency: ReturnType<typeof latencyReport>;
  selective: ReturnType<typeof selectiveReport>;
  calibration: ReturnType<typeof calibrationReport>;
  failures: number;
}

export interface ShadowReport {
  splits: string[];
  cases: number;
  comparators: ComparatorName[];
  reports: ComparatorReport[];
}

/** Compute every report for one run. Pure; no I/O. */
export function buildReport(
  run: ShadowRun,
  options: Pick<CliOptions, 'thresholds' | 'bins'>,
  splits: string[],
): ShadowReport {
  const reports = run.comparators.map<ComparatorReport>((comparator) => ({
    comparator,
    accuracy: accuracyReport(run.rows, comparator),
    macro: macroReport(run.rows, comparator),
    confusion: confusion(run.rows, comparator),
    latency: latencyReport(run.rows, comparator),
    selective: selectiveReport(run.rows, comparator, options.thresholds),
    calibration: calibrationReport(run.rows, comparator, options.bins),
    failures: run.failures[comparator] ?? 0,
  }));
  return { splits, cases: run.rows.length, comparators: run.comparators, reports };
}

/** Render a report as a plain-text table block. Never includes prompt text. */
export function formatReport(report: ShadowReport): string {
  const lines: string[] = [];
  lines.push(`Shadow comparison — ${report.cases} case(s) on split(s): ${report.splits.join(', ')}`);
  lines.push('');

  for (const r of report.reports) {
    const a = r.accuracy;
    lines.push(`=== ${r.comparator} ===`);
    lines.push(
      `accuracy ${pct(a.accuracy)} (${a.correct}/${a.total})  |  Wilson 95% lower ${pct(a.wilsonLower)}  |  failures ${r.failures}`,
    );
    lines.push(
      `macro-F1 ${r.macro.macroF1.toFixed(3)}  macro-P ${r.macro.macroPrecision.toFixed(3)}  macro-R ${r.macro.macroRecall.toFixed(3)}`,
    );
    lines.push(
      `latency p50 ${ms(r.latency.p50)}  p95 ${ms(r.latency.p95)}  max ${ms(r.latency.max)}  (n=${r.latency.n})`,
    );

    lines.push('per-class:');
    const header = `  ${'tier'.padEnd(11)}${'prec'.padEnd(8)}${'recall'.padEnd(8)}${'f1'.padEnd(8)}${'support'.padEnd(9)}predicted`;
    lines.push(header);
    for (const c of r.macro.perClass) {
      lines.push(
        `  ${c.label.padEnd(11)}${c.precision.toFixed(3).padEnd(8)}${c.recall.toFixed(3).padEnd(8)}${c.f1
          .toFixed(3)
          .padEnd(8)}${String(c.support).padEnd(9)}${c.predicted}`,
      );
    }

    if (r.selective.available) {
      lines.push('selective (confidence-gated):');
      lines.push(`  ${'thresh'.padEnd(9)}${'coverage'.padEnd(10)}${'sel-acc'.padEnd(10)}${'wilson-lo'.padEnd(11)}selected`);
      for (const p of r.selective.points) {
        lines.push(
          `  ${p.threshold.toFixed(2).padEnd(9)}${pct(p.coverage).padEnd(10)}${pct(p.selectiveAccuracy).padEnd(10)}${pct(
            p.wilsonLower,
          ).padEnd(11)}${p.selected}`,
        );
      }
    } else {
      lines.push('selective: unavailable (this comparator supplies no calibrated confidence)');
    }

    if (r.calibration.n > 0) {
      lines.push(
        `calibration (n=${r.calibration.n}): Brier ${r.calibration.brier!.toFixed(4)}  ECE ${r.calibration.ece!.toFixed(4)}`,
      );
      for (const b of r.calibration.bins) {
        if (b.n === 0) continue;
        lines.push(
          `  [${b.lo.toFixed(1)},${b.hi.toFixed(1)}) n=${String(b.n).padEnd(4)} conf ${b.meanConfidence.toFixed(
            3,
          )}  acc ${b.accuracy.toFixed(3)}  gap ${b.gap.toFixed(3)}`,
        );
      }
    } else {
      lines.push('calibration: unavailable (no full probability distribution supplied)');
    }

    lines.push('confusion (rows = expected, cols = predicted):');
    const labels = r.confusion.labels;
    lines.push(`  ${''.padEnd(11)}${labels.map((l) => l.slice(0, 8).padEnd(9)).join('')}`);
    for (const expected of TIERS) {
      const row = r.confusion.matrix[expected];
      lines.push(`  ${expected.padEnd(11)}${labels.map((l) => String(row[l] ?? 0).padEnd(9)).join('')}`);
    }
    const totalPredicted = (label: string): number =>
      Object.values(r.confusion.matrix).reduce((acc, m) => acc + (m[label] ?? 0), 0);
    lines.push(
      `  pseudo-predictions: abstain ${totalPredicted('abstain')}, error ${totalPredicted('error')}`,
    );
    lines.push('');
  }

  lines.push(
    'Note: benchmark uses PROVISIONAL (or adjudicated) labels; it is not a measure of the upstream generator\'s response quality.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `shadow-compare — offline-first three-way classifier shadow comparison

Usage: npx tsx eval/shadow-compare.ts [options]

Options:
  --live                 Also run remote comparators (embeddings, Jev); needs credentials.
  --comparators=a,b,c    Explicit comparator set (regex, embeddings, jev). Default: regex,
                         or all three when --live is set.
  --holdout              Include the holdout split. REFUSED unless an adjudicated-label
                         artifact exists (SHADOW_HOLDOUT_ADJUDICATED, default
                         eval/holdout-adjudicated.json with { adjudicated: true, labels }).
  --thresholds=0.5,0.7   Confidence gates for selective accuracy/coverage.
  --bins=10              Calibration bin count.
  --json                 Emit machine-readable JSON instead of tables.
  -h, --help             Show this help.

Default: validation split only, local regex comparator, no network, no writes.`;

function hasCredential(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI. Pure-ish: all environment/fs access is explicit here, and the
 * function returns text instead of printing, so it can be exercised offline.
 */
export async function runCli(argv: string[]): Promise<CliResult> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (err) {
    return { exitCode: 2, stdout: '', stderr: `${(err as Error).message}\n` };
  }

  if (options.help) return { exitCode: 0, stdout: `${HELP}\n`, stderr: '' };

  // Import the pilot dataset only when actually running (never in unit tests).
  const { PILOT_CASES } = await import('./pilot-dataset');

  const plan = planRun(PILOT_CASES, options);
  if (!plan.ok) {
    return { exitCode: 2, stdout: '', stderr: `${plan.reason}\n` };
  }

  const requested = options.comparators ?? (options.live ? [...COMPARATOR_NAMES] : ['regex' as ComparatorName]);
  const notes: string[] = [];
  const selected: ComparatorName[] = [];

  for (const name of requested) {
    if (name !== 'regex' && !options.live) {
      notes.push(`skipping ${name}: requires --live (remote comparator)`);
      continue;
    }
    if (name === 'embeddings' && options.live && !hasCredential('AI_GATEWAY_API_KEY')) {
      notes.push('skipping embeddings: no AI_GATEWAY_API_KEY (never printed)');
      continue;
    }
    if (name === 'jev' && options.live) {
      const transport = (process.env.JEV_TRANSPORT ?? 'direct').trim().toLowerCase();
      const envName = transport === 'gateway' ? 'AI_GATEWAY_API_KEY' : 'TYPESAFE_API_KEY';
      if (!hasCredential(envName)) {
        notes.push(`skipping jev: no ${envName} (never printed)`);
        continue;
      }
    }
    selected.push(name);
  }

  if (selected.length === 0) {
    return { exitCode: 2, stdout: '', stderr: 'No comparator could run. Use --live with credentials.\n' };
  }

  const comparators: Partial<Record<ComparatorName, ShadowClassifier>> = {};
  if (selected.includes('regex')) comparators.regex = regexComparator();
  if (selected.includes('embeddings')) comparators.embeddings = embeddingsComparator();
  if (selected.includes('jev')) comparators.jev = jevComparator();

  const run = await runShadowComparison({ cases: plan.cases, comparators });
  const report = buildReport(run, options, plan.splits);

  const header: string[] = [];
  header.push(`mode: ${options.live ? 'LIVE (remote calls enabled)' : 'offline (regex only)'}`);
  header.push(`comparators: ${run.comparators.join(', ')}`);
  header.push(`label source: ${options.holdout ? 'adjudicated holdout + provisional validation' : 'provisional validation'}`);
  for (const n of notes) header.push(`note: ${n}`);
  header.push('');

  if (options.json) {
    const payload = {
      mode: options.live ? 'live' : 'offline',
      splits: plan.splits,
      cases: run.rows.length,
      comparators: run.comparators,
      notes,
      // Rows carry no prompt text by construction.
      rows: run.rows,
      report: {
        failures: run.failures,
        metrics: report.reports.map((r) => ({
          comparator: r.comparator,
          accuracy: r.accuracy,
          macroF1: r.macro.macroF1,
          perClass: r.macro.perClass,
          latency: r.latency,
          selective: r.selective,
          calibration: { n: r.calibration.n, brier: r.calibration.brier, ece: r.calibration.ece, bins: r.calibration.bins },
          confusion: r.confusion,
          failures: r.failures,
        })),
      },
      disclaimer:
        'Label accuracy is task-type routing agreement on provisional/adjudicated labels; it does not measure response quality.',
    };
    return { exitCode: 0, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: header.join('\n') + '\n' };
  }

  return { exitCode: 0, stdout: `${header.join('\n')}${formatReport(report)}\n`, stderr: '' };
}

export async function main(argv: string[]): Promise<number> {
  // Load credentials from ~/.hermes/.env only for live runs, and never print them.
  if (argv.includes('--live')) {
    try {
      const { config: loadEnv } = await import('dotenv');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      loadEnv({ path: join(homedir(), '.hermes', '.env'), quiet: true });
    } catch {
      // dotenv optional; fall back to the ambient environment.
    }
  }

  const result = await runCli(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
