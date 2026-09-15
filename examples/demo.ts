/**
 * Demo: routes four representative prompts through the classifier and prints
 * which tier/model each one resolved to. Requires AI_GATEWAY_API_KEY in the env.
 *
 *   AI_GATEWAY_API_KEY=... npx tsx examples/demo.ts
 */

import { classify, modelForInput, routedGenerate, type RouteInput } from '../src/router';

const cases: Array<{ label: string; input: RouteInput }> = [
  { label: 'simple text', input: { prompt: 'Give me a one-line pun about coffee.' } },
  {
    label: 'reasoning',
    input: {
      prompt:
        'Analyze the trade-offs between event sourcing and CRUD for a high-write ledger, step by step.',
    },
  },
  { label: 'vision', input: { prompt: 'What is in this image?', hasImages: true } },
  {
    label: 'coding',
    input: { prompt: 'Write a Python function that memoizes an async fetch. ```py\n# here\n```' },
  },
];

async function main() {
  // 1) Dry-run: show routing decisions without spending tokens.
  console.log('=== Routing decisions ===');
  for (const c of cases) {
    const { tier } = modelForInput(c.input);
    console.log(`${c.label.padEnd(12)} -> tier=${tier}`);
  }

  // 2) Live call (uncomment to actually hit the gateway):
  // const r = await routedGenerate(cases[0].input);
  // console.log('\n=== Live ===\n', r.tier, r.text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
