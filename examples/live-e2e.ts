/**
 * Live end-to-end verification of the hybrid router.
 *   fast   -> OpenRouter (openrouter/auto)
 *   others -> Vercel AI Gateway
 * Exercises all four tiers with real generation calls.
 *
 *   npx tsx examples/live-e2e.ts
 *
 * Keys: AI_GATEWAY_API_KEY + OPENROUTER_API_KEY. Loaded from the environment,
 * then from ~/.hermes/.env as a fallback (where Hermes stores provider keys).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';

// Fallback: pull provider keys from Hermes's own .env if not already in the environment.
loadEnv({ path: join(homedir(), '.hermes', '.env') });

import { modelForInput, routedGenerate, setFastTierProvider, TIER_MODELS, type RouteInput } from '../src/router';
import { warnOnLowCredits } from '../src/credits';

const textCases: Array<{ label: string; input: RouteInput }> = [
  { label: 'fast', input: { prompt: 'Give me a one-line pun about coffee.' } },
  {
    label: 'reasoning',
    input: {
      prompt:
        'In two sentences, state the single biggest trade-off between event sourcing and CRUD for a high-write ledger.',
    },
  },
  {
    label: 'coding',
    input: { prompt: 'Write a tiny Python function that memoizes an async fetch. ```py\n# here\n```' },
  },
];

function label(input: RouteInput): string {
  const { tier, provider } = modelForInput(input);
  const model = provider === 'openrouter' ? 'openrouter/auto' : TIER_MODELS[tier];
  return `tier=${tier} provider=${provider} model=${model}`;
}

async function main() {
  // 0) Credit check + low-balance warnings (quality-first: warn, never cap).
  console.log('=== Credit balances ===');
  const { statuses } = await warnOnLowCredits({
    sink: (line) => console.log(`  ${line}`),
  });
  for (const s of statuses) {
    if (s.level === 'ok') console.log(`  ✅ ${s.message}`);
  }

  console.log('\n=== Live generation (all tiers) ===');
  for (const c of textCases) {
    process.stdout.write(`\n[${c.label}] ${label(c.input)}\n`);
    try {
      const r = await routedGenerate(c.input);
      const snippet = r.text.replace(/\s+/g, ' ').slice(0, 160);
      console.log(`  ✅ ${snippet}`);
      console.log(`  usage: ${JSON.stringify(r.usage)}`);
    } catch (e) {
      console.log(`  ❌ ${(e as Error).message}`);
    }
  }

  // Vision: route a real image through routedGenerate (the router builds the multimodal message).
  const visionInput: RouteInput = {
    prompt: 'In 5 words or fewer, what is in this image?',
    images: [readFileSync('/tmp/cat.jpg')],
  };
  process.stdout.write(`\n[vision] ${label(visionInput)}\n`);
  try {
    const r = await routedGenerate(visionInput);
    console.log(`  ✅ ${r.text.replace(/\s+/g, ' ').slice(0, 160)}`);
    console.log(`  usage: ${JSON.stringify(r.usage)}`);
  } catch (e) {
    console.log(`  ❌ ${(e as Error).message}`);
  }

  // Toggle demo: flip the fast tier to the gateway (machine-driven) and re-route.
  console.log('\n=== Fast-tier toggle ===');
  const fastInput: RouteInput = { prompt: 'Give me a one-line pun about tea.' };
  console.log(`  default:            [fast] ${label(fastInput)}`);
  setFastTierProvider('gateway');
  console.log(`  setFastTierProvider('gateway'): [fast] ${label(fastInput)}`);
  console.log(`  per-call override:  [fast] ${label({ ...fastInput, fastProvider: 'openrouter' })}`);
  setFastTierProvider(null); // reset
  try {
    setFastTierProvider('gateway');
    const r = await routedGenerate(fastInput);
    console.log(`  ✅ gateway-fast: ${r.text.replace(/\s+/g, ' ').slice(0, 120)} (provider=${r.provider})`);
  } catch (e) {
    console.log(`  ❌ ${(e as Error).message}`);
  } finally {
    setFastTierProvider(null);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
