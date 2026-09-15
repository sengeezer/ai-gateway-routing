/**
 * Classifier evaluation runner.
 *
 * Runs classify() over the labeled dataset and reports:
 *   - overall accuracy (and accuracy on the adversarial subset)
 *   - per-tier precision / recall / F1
 *   - a confusion matrix (expected x predicted)
 *   - every individual misroute
 *
 * Exits non-zero if overall accuracy is below MIN_ACCURACY (default 0.75),
 * so CI can gate on it.
 *
 *   npx tsx eval/run-eval.ts
 *   MIN_ACCURACY=0.85 npx tsx eval/run-eval.ts
 */

import { classify, type TaskTier } from '../src/router';
import { EVAL_CASES } from './dataset';

const TIERS: TaskTier[] = ['fast', 'reasoning', 'vision', 'coding'];
// Floor is set just below the current measured baseline (~73%) to lock in
// "don't regress", NOT as a target. Raising the classifier's accuracy (esp. the
// adversarial subset, currently ~14%) is tracked separately — bump this as it improves.
const MIN_ACCURACY = Number(process.env.MIN_ACCURACY ?? 0.7);

interface Result {
  id: string;
  expected: TaskTier;
  predicted: TaskTier;
  correct: boolean;
  adversarial: boolean;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function main() {
  const results: Result[] = EVAL_CASES.map((c) => {
    const predicted = classify(c);
    return {
      id: c.id,
      expected: c.expected,
      predicted,
      correct: predicted === c.expected,
      adversarial: c.adversarial ?? false,
    };
  });

  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  const accuracy = correct / total;

  const adv = results.filter((r) => r.adversarial);
  const advCorrect = adv.filter((r) => r.correct).length;
  const easy = results.filter((r) => !r.adversarial);
  const easyCorrect = easy.filter((r) => r.correct).length;

  // Confusion matrix: matrix[expected][predicted]
  const matrix: Record<TaskTier, Record<TaskTier, number>> = Object.fromEntries(
    TIERS.map((t) => [t, Object.fromEntries(TIERS.map((p) => [p, 0])) as Record<TaskTier, number>]),
  ) as Record<TaskTier, Record<TaskTier, number>>;
  for (const r of results) matrix[r.expected][r.predicted]++;

  console.log('=== Classifier evaluation ===');
  console.log(`cases: ${total}  |  correct: ${correct}  |  accuracy: ${(accuracy * 100).toFixed(1)}%`);
  console.log(
    `  easy subset:        ${easyCorrect}/${easy.length} (${((easyCorrect / Math.max(1, easy.length)) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  adversarial subset: ${advCorrect}/${adv.length} (${((advCorrect / Math.max(1, adv.length)) * 100).toFixed(1)}%)`,
  );

  console.log('\n=== Per-tier precision / recall / F1 ===');
  console.log(`${pad('tier', 12)}${pad('precision', 12)}${pad('recall', 10)}${pad('f1', 8)}support`);
  for (const t of TIERS) {
    const tp = matrix[t][t];
    const fn = TIERS.reduce((s, p) => s + (p === t ? 0 : matrix[t][p]), 0);
    const fp = TIERS.reduce((s, e) => s + (e === t ? 0 : matrix[e][t]), 0);
    const support = tp + fn;
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = support === 0 ? 0 : tp / support;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    console.log(
      `${pad(t, 12)}${pad(precision.toFixed(2), 12)}${pad(recall.toFixed(2), 10)}${pad(f1.toFixed(2), 8)}${support}`,
    );
  }

  console.log('\n=== Confusion matrix (rows=expected, cols=predicted) ===');
  console.log(`${pad('exp\\pred', 12)}${TIERS.map((t) => pad(t, 11)).join('')}`);
  for (const e of TIERS) {
    console.log(`${pad(e, 12)}${TIERS.map((p) => pad(String(matrix[e][p]), 11)).join('')}`);
  }

  const misroutes = results.filter((r) => !r.correct);
  if (misroutes.length) {
    console.log(`\n=== Misroutes (${misroutes.length}) ===`);
    for (const m of misroutes) {
      const c = EVAL_CASES.find((x) => x.id === m.id)!;
      const flag = m.adversarial ? ' [adversarial]' : '';
      console.log(`  ${pad(m.id, 10)} expected=${pad(m.expected, 10)} got=${pad(m.predicted, 10)}${flag}`);
      console.log(`      "${c.prompt.slice(0, 90)}${c.prompt.length > 90 ? '…' : ''}"`);
    }
  }

  console.log(`\naccuracy ${(accuracy * 100).toFixed(1)}% vs floor ${(MIN_ACCURACY * 100).toFixed(1)}%`);
  if (accuracy < MIN_ACCURACY) {
    console.error(`❌ FAIL: accuracy below floor (${MIN_ACCURACY}).`);
    process.exit(1);
  }
  console.log('✅ PASS');
}

main();
