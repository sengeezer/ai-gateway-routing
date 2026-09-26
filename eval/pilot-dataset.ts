/**
 * PILOT evaluation dataset for the shadow comparison of the regex, embeddings
 * and Jev classifiers.
 *
 * INDEPENDENTLY AUTHORED for this pilot. It is deliberately disjoint from:
 *   - eval/dataset.ts (the development/tuned set), and
 *   - the reference utterances in src/semantic-classifier.ts.
 * No prompt here is copied from an existing prompt template; each is a fresh,
 * realistic request written for this pilot.
 *
 * IMPORTANT — labels are PROVISIONAL, not adjudicated ground truth.
 * `expected` is an agent-authored best-guess tier for "what a careful reviewer
 * would route this to". It has NOT been reviewed by real users and is NOT a
 * record of real production outcomes. Treat it as a hypothesis to adjudicate,
 * never as a settled label.
 *
 * SPLITS
 *   - 'validation': may be inspected, discussed and used for error analysis.
 *   - 'holdout'   : DO NOT inspect predictions for these, and do not tune any
 *     classifier on them. Score once, report once, keep hands off.
 *
 * `subtype` is the task-shape annotation (what kind of request it is); it is
 * orthogonal to the tier. `ambiguous` marks wording that a reasonable reviewer
 * could route more than one way; those labels are the least firm.
 */

import type { RouteInput, TaskTier } from '../src/router';

/** Task-shape annotations covered by the pilot (>= 8 required). */
export const PILOT_SUBTYPES = [
  'short-factual',
  'translation-transform',
  'summarization',
  'strategic-analysis',
  'math-logic',
  'code-generation',
  'debugging',
  'vision',
  'adversarial-mixed',
  'ambiguous',
] as const;

export type PilotSubtype = (typeof PILOT_SUBTYPES)[number];

export type PilotSplit = 'validation' | 'holdout';

export interface PilotCase extends RouteInput {
  id: string;
  /** Provisional, agent-authored tier label. NOT adjudicated ground truth. */
  expected: TaskTier;
  subtype: PilotSubtype;
  split: PilotSplit;
  /** True when the text carries misleading keywords for the wrong tier. */
  adversarial?: boolean;
  /** True when a reviewer could defensibly pick a different tier. */
  ambiguous?: boolean;
  /** Why the case exists and where the risk of a wrong label lies. */
  note?: string;
}

export const PILOT_CASES: PilotCase[] = [
  /* ================= short-factual (fast) ================= */
  {
    id: 'pf-sf-01',
    expected: 'fast',
    subtype: 'short-factual',
    split: 'validation',
    prompt: 'How many minutes are in a full day?',
  },
  {
    id: 'pf-sf-02',
    expected: 'fast',
    subtype: 'short-factual',
    split: 'validation',
    prompt: 'Which planet orbits closest to the sun?',
  },
  {
    id: 'pf-sf-03',
    expected: 'fast',
    subtype: 'short-factual',
    split: 'validation',
    prompt: 'What currency do shops in Denmark take?',
  },
  {
    id: 'pf-sf-04',
    expected: 'fast',
    subtype: 'short-factual',
    split: 'validation',
    prompt: 'How do you spell onomatopoeia?',
  },
  {
    id: 'pf-sf-05',
    expected: 'fast',
    subtype: 'short-factual',
    split: 'validation',
    prompt: 'Name the tallest mountain in Africa.',
  },
  {
    id: 'pf-sf-06',
    expected: 'fast',
    subtype: 'short-factual',
    split: 'validation',
    prompt: 'What does the word lucid mean?',
  },
  {
    id: 'pf-sf-07',
    expected: 'fast',
    subtype: 'short-factual',
    split: 'validation',
    prompt: 'Who composed the Four Seasons?',
  },
  {
    id: 'pf-sf-08',
    expected: 'fast',
    subtype: 'short-factual',
    split: 'holdout',
    prompt: 'How many ounces are in a pound and a half?',
  },
  {
    id: 'pf-sf-09',
    expected: 'fast',
    subtype: 'short-factual',
    split: 'holdout',
    prompt: 'Who painted the Mona Lisa?',
  },
  {
    id: 'pf-sf-10',
    expected: 'fast',
    subtype: 'short-factual',
    split: 'holdout',
    prompt: 'At what temperature does mercury freeze in Celsius?',
  },
  {
    id: 'pf-sf-11',
    expected: 'fast',
    subtype: 'short-factual',
    split: 'holdout',
    prompt: 'Which ocean is the smallest by surface area?',
  },

  /* ================= translation-transform (fast) ================= */
  {
    id: 'pf-tt-01',
    expected: 'fast',
    subtype: 'translation-transform',
    split: 'validation',
    prompt: 'Translate "the meeting is cancelled" into Spanish.',
  },
  {
    id: 'pf-tt-02',
    expected: 'fast',
    subtype: 'translation-transform',
    split: 'validation',
    prompt: 'Rewrite this sentence in the passive voice: the chef prepared the meal.',
  },
  {
    id: 'pf-tt-03',
    expected: 'fast',
    subtype: 'translation-transform',
    split: 'validation',
    prompt: 'Convert 72 degrees Fahrenheit to Celsius.',
  },
  {
    id: 'pf-tt-04',
    expected: 'fast',
    subtype: 'translation-transform',
    split: 'validation',
    prompt: 'Turn this list into one comma-separated line: apples, pears, plums.',
  },
  {
    id: 'pf-tt-05',
    expected: 'fast',
    subtype: 'translation-transform',
    split: 'validation',
    prompt: 'Translate "thank you very much" into Japanese.',
  },
  {
    id: 'pf-tt-06',
    expected: 'fast',
    subtype: 'translation-transform',
    split: 'validation',
    prompt: 'Make this all lowercase: THE QUARTERLY REPORT IS DUE FRIDAY.',
  },
  {
    id: 'pf-tt-07',
    expected: 'fast',
    subtype: 'translation-transform',
    split: 'holdout',
    prompt: 'Rewrite "we are going" as a contraction.',
  },
  {
    id: 'pf-tt-08',
    expected: 'fast',
    subtype: 'translation-transform',
    split: 'holdout',
    prompt: 'Convert 3:45 pm into 24-hour time.',
  },
  {
    id: 'pf-tt-09',
    expected: 'fast',
    subtype: 'translation-transform',
    split: 'holdout',
    prompt: 'Translate "where is the train station" into German.',
  },

  /* ================= summarization (fast for short, reasoning for synthesis) ================= */
  {
    id: 'pf-sum-01',
    expected: 'fast',
    subtype: 'summarization',
    split: 'validation',
    prompt:
      'Summarize this in two sentences: the library extended its weekend hours after a survey showed ' +
      'students could not reach it before closing. Staff hours were shifted rather than added, so the ' +
      'budget did not change.',
  },
  {
    id: 'pf-sum-02',
    expected: 'fast',
    subtype: 'summarization',
    split: 'validation',
    prompt:
      'Give me a one-line tl;dr of these release notes: v2.4 adds SSO login, fixes the CSV export ' +
      'timezone bug, and raises the minimum supported Node version to 20.',
  },
  {
    id: 'pf-sum-03',
    expected: 'fast',
    subtype: 'summarization',
    split: 'validation',
    prompt:
      'Condense this thread into three bullet points: Ana asked for the invoice; Ben said it was sent ' +
      'to the old address; Ana confirmed the new address; Ben reissued the invoice.',
  },
  {
    id: 'pf-sum-04',
    expected: 'fast',
    subtype: 'summarization',
    split: 'validation',
    prompt:
      'Write a five-word headline for this excerpt: the city will replace its diesel bus fleet over ' +
      'four years, funded partly by a regional climate grant.',
  },
  {
    id: 'pf-sum-05',
    expected: 'reasoning',
    subtype: 'summarization',
    split: 'validation',
    note: 'synthesis across sources — needs reasoning, not a one-shot tl;dr',
    prompt:
      'Summarize the key changes in both of these changelogs and explain how they interact when ' +
      'upgrading: release A renamed the config keys and deprecated the old names; release B removed ' +
      'support for a dependency that those deprecated keys relied on.',
  },
  {
    id: 'pf-sum-06',
    expected: 'reasoning',
    subtype: 'summarization',
    split: 'validation',
    note: 'conflict-finding summary — needs judgement across documents',
    prompt:
      'Synthesize the main claims of these three abstracts and point out where they contradict each ' +
      'other: one reports a positive effect of the intervention, one reports none, and one reports a ' +
      'negative effect only for the subgroup that discontinued early.',
  },
  {
    id: 'pf-sum-07',
    expected: 'fast',
    subtype: 'summarization',
    split: 'holdout',
    prompt:
      'Boil this product description down to one sentence: a rechargeable headlamp with three ' +
      'brightness modes, a red night mode, and eight hours of runtime on low.',
  },
  {
    id: 'pf-sum-08',
    expected: 'fast',
    subtype: 'summarization',
    split: 'holdout',
    prompt:
      'Reduce these minutes to the decisions and their owners: Priya will draft the migration plan by ' +
      'Friday; Tom owns the vendor call; the team agreed to freeze scope until the pilot ends.',
  },
  {
    id: 'pf-sum-09',
    expected: 'reasoning',
    subtype: 'summarization',
    split: 'holdout',
    note: 'reconciling two accounts of one event — reasoning, not compression',
    prompt:
      'Reconcile these two incident reports into a single causal timeline and say which explanation ' +
      'the evidence better supports. Report one blames a misconfigured timeout and points at a ' +
      'deploy; report two blames a database failover and points at the same window.',
  },

  /* ================= strategic-analysis (reasoning) ================= */
  {
    id: 'pf-sa-01',
    expected: 'reasoning',
    subtype: 'strategic-analysis',
    split: 'validation',
    prompt:
      'We can hire two mid-level engineers or one senior engineer for the same budget. Argue which is ' +
      'the better move for a product team of six and why.',
  },
  {
    id: 'pf-sa-02',
    expected: 'reasoning',
    subtype: 'strategic-analysis',
    split: 'validation',
    prompt:
      'Lay out the trade-offs between staying on a monolith and splitting into services for a team of ' +
      'five with unpredictable seasonal scaling.',
  },
  {
    id: 'pf-sa-03',
    expected: 'reasoning',
    subtype: 'strategic-analysis',
    split: 'validation',
    prompt:
      'Should we launch in Europe before the US? Weigh regulatory cost against market timing and tell ' +
      'me what evidence would change your answer.',
  },
  {
    id: 'pf-sa-04',
    expected: 'reasoning',
    subtype: 'strategic-analysis',
    split: 'validation',
    prompt:
      'Churn rose four points in the quarter right after our price increase. Diagnose the likely ' +
      'causes and propose the next experiment to run.',
  },
  {
    id: 'pf-sa-05',
    expected: 'reasoning',
    subtype: 'strategic-analysis',
    split: 'validation',
    prompt:
      'Compare buying an off-the-shelf authentication vendor against building it ourselves, given a ' +
      'two-quarter deadline and no security specialist on staff.',
  },
  {
    id: 'pf-sa-06',
    expected: 'reasoning',
    subtype: 'strategic-analysis',
    split: 'holdout',
    prompt:
      'A customer who is a quarter of our revenue demands a feature that conflicts with our roadmap. ' +
      'Frame the decision and recommend an approach.',
  },
  {
    id: 'pf-sa-07',
    expected: 'reasoning',
    subtype: 'strategic-analysis',
    split: 'holdout',
    prompt:
      'Reason about whether to keep a legacy on-premise product alive for a shrinking but extremely ' +
      'loyal customer base.',
  },
  {
    id: 'pf-sa-08',
    expected: 'reasoning',
    subtype: 'strategic-analysis',
    split: 'holdout',
    prompt:
      'Weigh the second-order effects of moving from seat-based pricing to usage-based pricing for a ' +
      'tool with highly variable customer activity.',
  },
  {
    id: 'pf-sa-09',
    expected: 'reasoning',
    subtype: 'strategic-analysis',
    split: 'holdout',
    prompt:
      'Evaluate the risks of concentrating all of our cloud spend with a single provider over the next ' +
      'three years.',
  },
  {
    id: 'pf-sa-10',
    expected: 'reasoning',
    subtype: 'strategic-analysis',
    split: 'holdout',
    prompt:
      'Decide whether to run a design sprint now or ship the more narrowly scoped feature first, and ' +
      'justify the trade-off.',
  },
  {
    id: 'pf-sa-11',
    expected: 'reasoning',
    subtype: 'strategic-analysis',
    split: 'holdout',
    prompt:
      'Assess how a two-year runway should be split between growth spend and engineering headcount if ' +
      'we assume no further fundraising.',
  },

  /* ================= math-logic (fast for trivial, reasoning for proofs) ================= */
  {
    id: 'pf-ml-01',
    expected: 'fast',
    subtype: 'math-logic',
    split: 'validation',
    prompt: 'What is 17 percent of 240?',
  },
  {
    id: 'pf-ml-02',
    expected: 'fast',
    subtype: 'math-logic',
    split: 'validation',
    prompt: 'How many six-packs do I need for 40 guests if each drinks two bottles?',
  },
  {
    id: 'pf-ml-03',
    expected: 'reasoning',
    subtype: 'math-logic',
    split: 'validation',
    prompt:
      'A ladder leans against a wall with its foot 3 metres from the base and its top 9 metres up. ' +
      'Derive its length and explain the reasoning.',
  },
  {
    id: 'pf-ml-04',
    expected: 'reasoning',
    subtype: 'math-logic',
    split: 'validation',
    prompt:
      'If all bloops are razzles and no razzles are green, can a bloop be green? Justify your answer.',
  },
  {
    id: 'pf-ml-05',
    expected: 'reasoning',
    subtype: 'math-logic',
    split: 'validation',
    prompt: 'Prove by induction that the sum of the first n odd numbers equals n squared.',
  },
  {
    id: 'pf-ml-06',
    expected: 'reasoning',
    subtype: 'math-logic',
    split: 'validation',
    prompt:
      'Two trains leave cities 300 km apart heading toward each other at 60 and 40 km/h. Compute and ' +
      'justify when they meet.',
  },
  {
    id: 'pf-ml-07',
    expected: 'reasoning',
    subtype: 'math-logic',
    split: 'validation',
    prompt:
      'You have a 5 litre jug and a 3 litre jug and unlimited water. Derive the steps to measure ' +
      'exactly 4 litres.',
  },
  {
    id: 'pf-ml-08',
    expected: 'reasoning',
    subtype: 'math-logic',
    split: 'holdout',
    prompt:
      'Show rigorously that a geometric series with a ratio strictly below one converges, and state ' +
      'the limit.',
  },
  {
    id: 'pf-ml-09',
    expected: 'reasoning',
    subtype: 'math-logic',
    split: 'holdout',
    prompt:
      'Explain the pigeonhole principle and use it to show that in any group of 13 people two share a ' +
      'birth month.',
  },
  {
    id: 'pf-ml-10',
    expected: 'reasoning',
    subtype: 'math-logic',
    split: 'holdout',
    prompt:
      'Derive why the interior angles of a convex polygon with n sides sum to (n minus 2) times 180 ' +
      'degrees.',
  },
  {
    id: 'pf-ml-11',
    expected: 'reasoning',
    subtype: 'math-logic',
    split: 'holdout',
    note: 'classic trap; a careless solver answers 10 cents — reasoning, not quick arithmetic',
    prompt:
      'A bat and a ball cost $1.10 together and the bat costs $1.00 more than the ball. Work out the ' +
      "ball's price and explain the common trap.",
  },

  /* ================= code-generation (coding) ================= */
  {
    id: 'pf-cg-01',
    expected: 'coding',
    subtype: 'code-generation',
    split: 'validation',
    prompt: 'Write a Python helper that chunks a list into fixed-size batches without dropping the tail.',
  },
  {
    id: 'pf-cg-02',
    expected: 'coding',
    subtype: 'code-generation',
    split: 'validation',
    prompt: 'Implement a debounce utility in TypeScript that also exposes a cancel method.',
  },
  {
    id: 'pf-cg-03',
    expected: 'coding',
    subtype: 'code-generation',
    split: 'validation',
    prompt: 'Write a Rust function that returns the second-largest distinct value from a slice.',
  },
  {
    id: 'pf-cg-04',
    expected: 'coding',
    subtype: 'code-generation',
    split: 'validation',
    prompt:
      'Generate a Go HTTP handler that streams a large CSV response without buffering the whole file ' +
      'in memory.',
  },
  {
    id: 'pf-cg-05',
    expected: 'coding',
    subtype: 'code-generation',
    split: 'validation',
    prompt:
      'Write a SQL window-function query that ranks products by monthly revenue within each category.',
  },
  {
    id: 'pf-cg-06',
    expected: 'coding',
    subtype: 'code-generation',
    split: 'validation',
    prompt: 'Implement a retry wrapper with exponential backoff and jitter in JavaScript.',
  },
  {
    id: 'pf-cg-07',
    expected: 'coding',
    subtype: 'code-generation',
    split: 'holdout',
    prompt:
      'Write a bash script that rotates log files older than seven days and prints how much space was ' +
      'freed.',
  },
  {
    id: 'pf-cg-08',
    expected: 'coding',
    subtype: 'code-generation',
    split: 'holdout',
    prompt:
      'Create a Python dataclass representing a weighted graph edge plus a function that detects ' +
      'cycles in the graph.',
  },
  {
    id: 'pf-cg-09',
    expected: 'coding',
    subtype: 'code-generation',
    split: 'holdout',
    prompt:
      'Write a small React hook that persists state to localStorage and stays safe during server-side ' +
      'rendering.',
  },
  {
    id: 'pf-cg-10',
    expected: 'coding',
    subtype: 'code-generation',
    split: 'holdout',
    prompt: 'Implement a least-recently-used cache class in Kotlin with a fixed capacity.',
  },
  {
    id: 'pf-cg-11',
    expected: 'coding',
    subtype: 'code-generation',
    split: 'holdout',
    prompt:
      'Write a JavaScript regular expression that validates ISO-8601 dates with optional time ' +
      'components.',
  },

  /* ================= debugging (coding) =================
   * Note: most of these carry no code tokens or fences on purpose — they probe
   * whether the classifier recognises a coding intent from plain language. */
  {
    id: 'pf-dbg-01',
    expected: 'coding',
    subtype: 'debugging',
    split: 'validation',
    note: 'coding intent with no code tokens — regex-suspect',
    prompt:
      'A fetch call returns an empty body only when the URL has a trailing slash. Help me track down ' +
      'why.',
  },
  {
    id: 'pf-dbg-02',
    expected: 'coding',
    subtype: 'debugging',
    split: 'validation',
    note: 'coding intent with no code tokens',
    prompt: 'A scheduled job silently stops after a few hours. How would you trace where it dies?',
  },
  {
    id: 'pf-dbg-03',
    expected: 'coding',
    subtype: 'debugging',
    split: 'validation',
    note: 'coding intent, plain English',
    prompt: 'My tests pass one at a time but fail when the whole suite runs together. Diagnose why.',
  },
  {
    id: 'pf-dbg-04',
    expected: 'coding',
    subtype: 'debugging',
    split: 'validation',
    prompt:
      'The database occasionally deadlocks under load. Walk me through isolating which transaction ' +
      'causes it.',
  },
  {
    id: 'pf-dbg-05',
    expected: 'coding',
    subtype: 'debugging',
    split: 'validation',
    prompt:
      'The container image builds fine locally but the pod crashes on start in the cluster with exit ' +
      'code 137. Debug it.',
  },
  {
    id: 'pf-dbg-06',
    expected: 'coding',
    subtype: 'debugging',
    split: 'validation',
    note: 'coding intent, infrastructure wording only',
    prompt:
      'An endpoint intermittently returns 502 only when requests come through the CDN. How do I find ' +
      'which layer drops them?',
  },
  {
    id: 'pf-dbg-07',
    expected: 'coding',
    subtype: 'debugging',
    split: 'holdout',
    prompt: 'A component re-renders endlessly after I added one dependency. Find the loop.',
  },
  {
    id: 'pf-dbg-08',
    expected: 'coding',
    subtype: 'debugging',
    split: 'holdout',
    prompt: 'A background worker leaks memory over several days. Outline how to locate the leak.',
  },
  {
    id: 'pf-dbg-09',
    expected: 'coding',
    subtype: 'debugging',
    split: 'holdout',
    prompt:
      'WebSocket connections drop every 60 seconds behind the load balancer. Track down the timeout ' +
      'responsible.',
  },

  /* ================= vision (vision — by image presence) ================= */
  {
    id: 'pf-vis-01',
    expected: 'vision',
    subtype: 'vision',
    split: 'validation',
    images: ['https://pilot.local/screenshots/build-failure.png'],
    prompt: 'What does the error overlay in this screenshot say?',
  },
  {
    id: 'pf-vis-02',
    expected: 'vision',
    subtype: 'vision',
    split: 'validation',
    images: ['https://pilot.local/scans/invoice-0413.jpg'],
    prompt: 'Extract the line items and totals from this scanned invoice.',
  },
  {
    id: 'pf-vis-03',
    expected: 'vision',
    subtype: 'vision',
    split: 'validation',
    images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='],
    prompt: 'In this photo, is the router indicator light blinking or steady?',
  },
  {
    id: 'pf-vis-04',
    expected: 'vision',
    subtype: 'vision',
    split: 'validation',
    hasImages: true,
    prompt: 'Compare the before and after photos and describe what changed in the room.',
  },
  {
    id: 'pf-vis-05',
    expected: 'vision',
    subtype: 'vision',
    split: 'validation',
    note: 'image plus coding-ish wording — image presence must win',
    prompt: 'Here is a photo of the stack trace on my screen; which exception is at the top?',
    images: ['https://pilot.local/screenshots/stack.png'],
  },
  {
    id: 'pf-vis-06',
    expected: 'vision',
    subtype: 'vision',
    split: 'holdout',
    prompt: 'What dish is on the plate, and does the portion look large?',
    images: ['https://pilot.local/photos/dinner.jpg'],
  },
  {
    id: 'pf-vis-07',
    expected: 'vision',
    subtype: 'vision',
    split: 'holdout',
    prompt: 'Read the handwritten serial number from this equipment label.',
    images: ['https://pilot.local/scans/label.png'],
  },
  {
    id: 'pf-vis-08',
    expected: 'vision',
    subtype: 'vision',
    split: 'holdout',
    prompt: 'Does this chart trend upward or downward between the first and last quarter?',
    images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='],
  },
  {
    id: 'pf-vis-09',
    expected: 'vision',
    subtype: 'vision',
    split: 'holdout',
    hasImages: true,
    prompt: 'Identify the road sign and the speed limit shown in this dashcam frame.',
  },

  /* ================= adversarial-mixed (tier per underlying intent) ================= */
  {
    id: 'pf-adv-01',
    expected: 'fast',
    subtype: 'adversarial-mixed',
    split: 'validation',
    adversarial: true,
    note: '"class" as ordinary prose — regex may misroute to coding',
    prompt: 'What time does the pottery class start on Thursday?',
  },
  {
    id: 'pf-adv-02',
    expected: 'fast',
    subtype: 'adversarial-mixed',
    split: 'validation',
    adversarial: true,
    note: '"import" as ordinary prose',
    prompt: 'Why is it important to import healthy snacks for the school fair?',
  },
  {
    id: 'pf-adv-03',
    expected: 'fast',
    subtype: 'adversarial-mixed',
    split: 'validation',
    adversarial: true,
    note: '"analyze" attached to a trivial lookup task',
    prompt: 'Can you analyze this grocery receipt for me: milk 2.50, eggs 3.20, bread 1.80?',
  },
  {
    id: 'pf-adv-04',
    expected: 'reasoning',
    subtype: 'adversarial-mixed',
    split: 'validation',
    adversarial: true,
    note: '"return" reads code-ish but the task is an investment decision',
    prompt:
      'Explain the return on investment of the new paint line we installed, given the volumes we ' +
      'actually hit.',
  },
  {
    id: 'pf-adv-05',
    expected: 'fast',
    subtype: 'adversarial-mixed',
    split: 'validation',
    adversarial: true,
    note: '"class of 2019" is a cohort, not a code class',
    prompt: 'The class of 2019 reunion is Saturday. Write a short reminder for the group chat.',
  },
  {
    id: 'pf-adv-06',
    expected: 'fast',
    subtype: 'adversarial-mixed',
    split: 'validation',
    adversarial: true,
    note: '"debug" used about a personal routine, no software involved',
    prompt: 'Debug my morning routine: I keep missing the bus even though I leave on time.',
  },
  {
    id: 'pf-adv-07',
    expected: 'reasoning',
    subtype: 'adversarial-mixed',
    split: 'holdout',
    adversarial: true,
    note: '"import" (trade) + "reason" — underlying task is a pricing decision',
    prompt:
      'Import duties on ceramics doubled last month. Reason about whether we should reprice the ' +
      'catalogue or absorb the cost.',
  },
  {
    id: 'pf-adv-08',
    expected: 'reasoning',
    subtype: 'adversarial-mixed',
    split: 'holdout',
    adversarial: true,
    note: '"class action" + "analyze" — legal judgement, not coding',
    prompt:
      'Analyze the class action settlement terms and tell me whether the offer is fair to the ' +
      'claimants.',
  },
  {
    id: 'pf-adv-09',
    expected: 'fast',
    subtype: 'adversarial-mixed',
    split: 'holdout',
    adversarial: true,
    note: '"write a function" here means an HR function/role, not code',
    prompt:
      'Write a one-paragraph function description for the backend role we are hiring, for the job ad.',
  },
  {
    id: 'pf-adv-10',
    expected: 'coding',
    subtype: 'adversarial-mixed',
    split: 'holdout',
    adversarial: true,
    note: 'real coding task with no code tokens or fence at all',
    prompt:
      'My sort order goes wrong when two people share a surname. How do I fix it in the app I built?',
  },
  {
    id: 'pf-adv-11',
    expected: 'coding',
    subtype: 'adversarial-mixed',
    split: 'holdout',
    adversarial: true,
    note: 'real debugging task phrased as a business symptom',
    prompt:
      'Checkout totals come out one cent low, but only for certain carts. How do I track the cause ' +
      'down?',
  },

  /* ================= ambiguous (provisional labels, weakest) ================= */
  {
    id: 'pf-amb-01',
    expected: 'fast',
    subtype: 'ambiguous',
    split: 'validation',
    ambiguous: true,
    note: 'light critique of a paragraph — fast or reasoning both defensible',
    prompt:
      'Here is a paragraph I wrote — is it any good? "The team shipped early, which surprised ' +
      'everyone, and the launch went smoothly."',
  },
  {
    id: 'pf-amb-02',
    expected: 'fast',
    subtype: 'ambiguous',
    split: 'validation',
    ambiguous: true,
    note: 'summarize-or-expand leaves the transformation underspecified',
    prompt: 'Summarize or expand this bullet as you see fit: launch on Tuesday.',
  },
  {
    id: 'pf-amb-03',
    expected: 'coding',
    subtype: 'ambiguous',
    split: 'validation',
    ambiguous: true,
    note: 'could be read as a product decision (fast) rather than a code fix',
    prompt: 'What should we do about the bug our users keep hitting?',
  },
  {
    id: 'pf-amb-04',
    expected: 'fast',
    subtype: 'ambiguous',
    split: 'validation',
    ambiguous: true,
    note: 'chained fast operations — no single clean tier',
    prompt: 'Translate this clause into plain English and then summarize it in one line.',
  },
  {
    id: 'pf-amb-05',
    expected: 'fast',
    subtype: 'ambiguous',
    split: 'validation',
    ambiguous: true,
    note: 'too thin to infer intent; routed to the cheapest safe tier',
    prompt: 'Is 42 the answer?',
  },
  {
    id: 'pf-amb-06',
    expected: 'reasoning',
    subtype: 'ambiguous',
    split: 'validation',
    ambiguous: true,
    note: 'no referent for "this" — could be a quick explanation or deep analysis',
    prompt: 'Explain why this works the way it does, without assuming any prior knowledge.',
  },
  {
    id: 'pf-amb-07',
    expected: 'fast',
    subtype: 'ambiguous',
    split: 'holdout',
    ambiguous: true,
    note: 'no content at all; provisional fast label, could be anything',
    prompt: 'Help.',
  },
  {
    id: 'pf-amb-08',
    expected: 'fast',
    subtype: 'ambiguous',
    split: 'holdout',
    ambiguous: true,
    note: 'no target given; provisional fast label',
    prompt: 'Make it better.',
  },
  {
    id: 'pf-amb-09',
    expected: 'fast',
    subtype: 'ambiguous',
    split: 'holdout',
    ambiguous: true,
    note: 'short copy request — fast or reasoning both defensible',
    prompt: 'Write something short about our launch.',
  },
];
