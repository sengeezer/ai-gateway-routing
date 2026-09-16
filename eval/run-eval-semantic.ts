/**
 * Semantic classifier accuracy GATE (for CI).
 *
 * Runs the embeddings classifier over the labeled set and exits non-zero if overall
 * accuracy is below MIN_SEMANTIC_ACCURACY (default 0.90; we measure ~0.97 locally).
 * Needs AI_GATEWAY_API_KEY in the environment (a GitHub repo secret in CI).
 *
 *   AI_GATEWAY_API_KEY=... npx tsx eval/run-eval-semantic.ts
 */

import { classifySemantic, EMBED_MODEL } from '../src/semantic-classifier';
import { EVAL_CASES } from './dataset';

const MIN = Number(process.env.MIN_SEMANTIC_ACCURACY ?? 0.9);

async function main() {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error('AI_GATEWAY_API_KEY not set — cannot run the semantic eval.');
    process.exit(2);
  }

  let correct = 0;
  const misroutes: string[] = [];
  for (const c of EVAL_CASES) {
    const got = await classifySemantic(c);
    if (got === c.expected) correct++;
    else misroutes.push(`  ${c.id.padEnd(10)} expected=${c.expected.padEnd(10)} got=${got}`);
  }

  const acc = correct / EVAL_CASES.length;
  console.log(`semantic classifier — model=${EMBED_MODEL}`);
  console.log(`accuracy: ${(acc * 100).toFixed(1)}% (${correct}/${EVAL_CASES.length}) vs floor ${(MIN * 100).toFixed(1)}%`);
  if (misroutes.length) {
    console.log(`misroutes (${misroutes.length}):`);
    console.log(misroutes.join('\n'));
  }

  if (acc < MIN) {
    console.error(`❌ FAIL: semantic accuracy below floor (${MIN}).`);
    process.exit(1);
  }
  console.log('✅ PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
