/**
 * Labeled evaluation set for the tier classifier.
 *
 * Each case maps a representative input to the tier a human would expect.
 * The set deliberately includes ADVERSARIAL cases (prose that contains code-ish
 * or reasoning-ish keywords) so the measured accuracy reflects real weaknesses
 * of the regex+length heuristic rather than a flattering best case.
 *
 * `expected` is the ground-truth tier. Keep this human-curated.
 */

import type { RouteInput, TaskTier } from '../src/router';

export interface EvalCase extends RouteInput {
  id: string;
  expected: TaskTier;
  /** Why this case exists / what it probes. */
  note?: string;
  /** True if this is a known hard/adversarial case for the heuristic. */
  adversarial?: boolean;
}

export const EVAL_CASES: EvalCase[] = [
  // ---- fast: short, simple text ----
  { id: 'fast-1', expected: 'fast', prompt: 'What time is it in Tokyo?' },
  { id: 'fast-2', expected: 'fast', prompt: 'Give me a one-line pun about coffee.' },
  { id: 'fast-3', expected: 'fast', prompt: 'Translate "good morning" into French.' },
  { id: 'fast-4', expected: 'fast', prompt: 'Capital of Australia?' },
  { id: 'fast-5', expected: 'fast', prompt: 'Summarize this in one sentence: the cat sat on the mat.' },
  { id: 'fast-6', expected: 'fast', prompt: 'Say hello.' },
  { id: 'fast-7', expected: 'fast', prompt: 'What is 12 times 8?' },
  {
    id: 'fast-8',
    expected: 'fast',
    adversarial: true,
    note: 'contains "class" as ordinary prose — heuristic may misroute to coding',
    prompt: 'What time does the yoga class start on Saturday?',
  },
  {
    id: 'fast-9',
    expected: 'fast',
    adversarial: true,
    note: 'contains "import" as ordinary prose',
    prompt: 'Why is it so important to drink water?',
  },
  {
    id: 'fast-10',
    expected: 'fast',
    adversarial: true,
    note: 'contains "analyse" casually — heuristic may misroute to reasoning',
    prompt: 'Can you analyse this word for me: banana?',
  },

  // ---- reasoning: hard analysis, multi-step, long ----
  {
    id: 'reason-1',
    expected: 'reasoning',
    prompt: 'Analyze the trade-offs between event sourcing and CRUD for a high-write ledger, step by step.',
  },
  {
    id: 'reason-2',
    expected: 'reasoning',
    prompt: 'Prove that the square root of 2 is irrational and explain each step.',
  },
  {
    id: 'reason-3',
    expected: 'reasoning',
    prompt: 'Derive the bias-variance decomposition and reason about its implications for model selection.',
  },
  {
    id: 'reason-4',
    expected: 'reasoning',
    prompt: 'What is the optimal strategy for a two-player zero-sum game with this payoff matrix, and why?',
  },
  {
    id: 'reason-5',
    expected: 'reasoning',
    prompt: 'Explain why interest-rate changes propagate to equity valuations, walking through the mechanism.',
  },
  {
    id: 'reason-6',
    expected: 'reasoning',
    adversarial: true,
    note: 'long complex prompt (~1278 chars) with no keywords — falls UNDER the 1500 length threshold, so heuristic misroutes to fast (finding: threshold too high)',
    prompt:
      'I run a mid-size logistics company and I am trying to decide how to reorganize our regional distribution. ' +
      'We currently have three warehouses serving twelve metro areas, and demand has shifted noticeably over the past ' +
      'two years toward the southern markets while the northern markets have softened. Our lease on the northern ' +
      'warehouse is up for renewal next quarter, and we could either renew it, downsize it, relocate it further south, ' +
      'or consolidate into the two remaining sites and rely more heavily on third-party carriers for the last mile. ' +
      'Each option has different implications for delivery time, fixed cost, headcount, and our ability to absorb ' +
      'seasonal spikes around the holidays. We also have a labor agreement in the north that makes rapid headcount ' +
      'changes expensive and slow. On top of that, fuel prices have been volatile, and our largest customer has hinted ' +
      'they may move to next-day delivery expectations across all metros within a year, which would tighten our ' +
      'service-level requirements considerably. Given all of this, walk me through how you would frame the decision, ' +
      'what data I should gather first, and how to weigh the competing factors so that we do not over-optimize for ' +
      'short-term cost at the expense of the service levels our customers will soon demand.',
  },
  {
    id: 'reason-7',
    expected: 'reasoning',
    adversarial: true,
    note: 'reasoning task with NO trigger keyword and short — heuristic will likely miss (route fast)',
    prompt: 'Should a startup with 18 months of runway raise now or wait two quarters? Make the case both ways.',
  },
  {
    id: 'reason-8',
    expected: 'reasoning',
    adversarial: true,
    note: 'multi-step logic puzzle, no keyword, short',
    prompt: 'Three switches, one bulb in another room. You may enter once. How do you tell which switch works?',
  },

  // ---- coding: code present or explicit code task ----
  {
    id: 'code-1',
    expected: 'coding',
    prompt: 'Write a Python function that memoizes an async fetch. ```py\n# here\n```',
  },
  {
    id: 'code-2',
    expected: 'coding',
    prompt: 'Fix this: function add(a, b) { retrun a + b }',
  },
  {
    id: 'code-3',
    expected: 'coding',
    prompt: 'const x = useMemo(() => compute(), []); why does this re-run every render?',
  },
  {
    id: 'code-4',
    expected: 'coding',
    prompt: 'Write a SQL query: SELECT top customers by revenue in the last 30 days.',
  },
  {
    id: 'code-5',
    expected: 'coding',
    prompt: 'class Foo: pass — how do I add a constructor in Python?',
  },
  {
    id: 'code-6',
    expected: 'coding',
    prompt: 'Refactor this TypeScript to use async/await instead of .then() chains.',
  },
  {
    id: 'code-7',
    expected: 'coding',
    adversarial: true,
    note: 'coding request with no code tokens and no fence — heuristic likely misses',
    prompt: 'How do I reverse a linked list in place?',
  },
  {
    id: 'code-8',
    expected: 'coding',
    adversarial: true,
    note: 'debugging ask, plain English, no code fence',
    prompt: 'My unit tests pass locally but fail in the pipeline with a timeout. How should I debug that?',
  },

  // ---- vision: image present ----
  { id: 'vis-1', expected: 'vision', hasImages: true, prompt: 'What is in this image?' },
  {
    id: 'vis-2',
    expected: 'vision',
    images: ['https://example.com/chart.png'],
    prompt: 'Read the value at the peak of this chart.',
  },
  {
    id: 'vis-3',
    expected: 'vision',
    images: ['data:image/png;base64,iVBORw0KGgo='],
    prompt: 'Describe the scene.',
  },
  {
    id: 'vis-4',
    expected: 'vision',
    hasImages: true,
    note: 'image + code words present — vision must win over coding',
    prompt: 'Here is a screenshot of my function; why does this class fail to import?',
  },
];
