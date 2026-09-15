/**
 * Head-to-head: regex baseline vs. embeddings classifier, on the same labeled set.
 *
 *   npx tsx eval/compare.ts
 *   EMBED_MODEL=cohere/embed-v4.0 npx tsx eval/compare.ts
 *
 * Needs AI_GATEWAY_API_KEY (loaded from env, then ~/.hermes/.env as fallback).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: join(homedir(), '.hermes', '.env') });

import { classify, type TaskTier } from '../src/router';
import { classifySemantic, EMBED_MODEL } from '../src/semantic-classifier';
import { EVAL_CASES } from './dataset';

function acc(rows: { correct: boolean }[]): number {
  return rows.length ? rows.filter((r) => r.correct).length / rows.length : 0;
}
function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  console.log(`Comparing on ${EVAL_CASES.length} cases  |  embedding model: ${EMBED_MODEL}\n`);

  const rows = [];
  for (const c of EVAL_CASES) {
    const regex = classify(c);
    const semantic = await classifySemantic(c);
    rows.push({
      id: c.id,
      expected: c.expected as TaskTier,
      regex,
      semantic,
      adversarial: c.adversarial ?? false,
      regexCorrect: regex === c.expected,
      semanticCorrect: semantic === c.expected,
    });
  }

  const overall = { regex: acc(rows.map((r) => ({ correct: r.regexCorrect }))), semantic: acc(rows.map((r) => ({ correct: r.semanticCorrect }))) };
  const adv = rows.filter((r) => r.adversarial);
  const easy = rows.filter((r) => !r.adversarial);

  console.log('=== Accuracy ===');
  console.log(`${'subset'.padEnd(16)}${'regex'.padEnd(10)}${'semantic'.padEnd(10)}delta`);
  const line = (name: string, sub: typeof rows) => {
    const r = acc(sub.map((x) => ({ correct: x.regexCorrect })));
    const s = acc(sub.map((x) => ({ correct: x.semanticCorrect })));
    const d = s - r;
    console.log(`${name.padEnd(16)}${pct(r).padEnd(10)}${pct(s).padEnd(10)}${d >= 0 ? '+' : ''}${pct(d)}`);
  };
  line('overall', rows);
  line('easy', easy);
  line('adversarial', adv);

  const changed = rows.filter((r) => r.regex !== r.semantic);
  console.log(`\n=== Disagreements (${changed.length}) ===`);
  for (const r of changed) {
    const rf = r.regexCorrect ? '✓' : '✗';
    const sf = r.semanticCorrect ? '✓' : '✗';
    const verdict = r.semanticCorrect && !r.regexCorrect ? ' (semantic WINS)' : !r.semanticCorrect && r.regexCorrect ? ' (semantic LOSES)' : '';
    console.log(`  ${r.id.padEnd(10)} exp=${r.expected.padEnd(10)} regex=${r.regex}${rf} semantic=${r.semantic}${sf}${verdict}`);
  }

  const wins = changed.filter((r) => r.semanticCorrect && !r.regexCorrect).length;
  const losses = changed.filter((r) => !r.semanticCorrect && r.regexCorrect).length;
  console.log(`\nnet: semantic fixes ${wins}, breaks ${losses}  (overall ${pct(overall.regex)} -> ${pct(overall.semantic)})`);
  console.log(overall.semantic > overall.regex ? '✅ semantic wins' : overall.semantic === overall.regex ? '➖ tie' : '❌ regex wins');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
