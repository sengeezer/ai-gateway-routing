/**
 * Embeddings-based ("semantic") tier classifier.
 *
 * Same technique as Aurelio Labs' (Python-only) semantic-router: embed a handful
 * of reference utterances per tier, then classify a prompt by max cosine similarity
 * to any reference. Implemented directly on our existing stack (ai `embed`/`embedMany`
 * + the gateway's embedding models) — no new runtime, no Python.
 *
 * Vision stays a hard rule (image presence), exactly as in the regex classifier —
 * embeddings of the text can't know an image is attached.
 *
 * Reference utterances are deliberately DISJOINT from eval/dataset.ts to avoid
 * train/test leakage when measuring accuracy.
 *
 * Env: EMBED_MODEL (default 'openai/text-embedding-3-small'), AI_GATEWAY_API_KEY.
 */

import { embed, embedMany } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import type { RouteInput, TaskTier } from './router';

export const EMBED_MODEL = process.env.EMBED_MODEL ?? 'openai/text-embedding-3-small';

type TextTier = Exclude<TaskTier, 'vision'>;

/** Reference utterances per text tier. Curated, disjoint from the eval set. */
const REFERENCES: Record<TextTier, string[]> = {
  fast: [
    'what is the capital of Spain',
    'convert 10 miles to kilometers',
    'what day of the week is it',
    'give me a synonym for happy',
    'how do you spell restaurant',
    'tell me a short joke',
    'what is 45 plus 17',
    'define the word ephemeral',
    'when did World War 2 end',
    'what is the boiling point of water',
  ],
  reasoning: [
    'weigh the pros and cons of remote work versus office work',
    'walk me through how you would decide between two job offers',
    'what are the second-order effects of raising interest rates',
    'evaluate whether we should build or buy this component',
    'think step by step about the best pricing strategy for a new product',
    'compare the long-term risks of these two investment approaches',
    'reason through whether this business plan is viable',
    'what assumptions underlie this argument and are they sound',
    'plan a migration strategy weighing cost, risk, and timeline',
    'justify which architecture is better for our constraints',
    // Formal/mathematical reasoning — proofs and derivations (disjoint from eval set).
    'prove that there are infinitely many prime numbers',
    'show by mathematical induction that this formula holds for all natural numbers',
    'derive the quadratic formula by completing the square',
    'demonstrate rigorously why the harmonic series diverges',
    'explain why no algorithm can decide the halting problem',
  ],
  coding: [
    'write a function that reverses a string',
    'fix the bug in this loop',
    'how do I center a div with flexbox',
    'refactor this method to be more readable',
    'explain what this regular expression matches',
    'write a unit test for this function',
    'why does my program throw a null pointer exception',
    'implement binary search in java',
    'optimize this database query for performance',
    'how do I parse JSON in python',
  ],
};

interface RefVec {
  tier: TextTier;
  vec: number[];
}

let _cache: { model: string; refs: RefVec[] } | null = null;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Embed (and cache) the reference utterances for the active model. */
async function ensureRefs(): Promise<{ model: string; refs: RefVec[] }> {
  if (_cache && _cache.model === EMBED_MODEL) return _cache;
  const flat: { tier: TextTier; text: string }[] = [];
  for (const tier of Object.keys(REFERENCES) as TextTier[]) {
    for (const text of REFERENCES[tier]) flat.push({ tier, text });
  }
  const { embeddings } = await embedMany({
    model: gateway.textEmbeddingModel(EMBED_MODEL),
    values: flat.map((f) => f.text),
  });
  const refs: RefVec[] = flat.map((f, i) => ({ tier: f.tier, vec: embeddings[i] }));
  _cache = { model: EMBED_MODEL, refs };
  return _cache;
}

/** Preload the reference embeddings (optional warm-up). */
export async function warmupSemantic(): Promise<void> {
  await ensureRefs();
}

export interface SemanticResult {
  tier: TaskTier;
  /** Best cosine score for the winning tier (undefined for rule-based tiers). */
  score?: number;
  /** Per-tier best cosine scores (undefined for rule-based tiers). */
  scores?: Record<TextTier, number>;
}

/** Classify with detail (scores) for debugging/eval. */
export async function classifySemanticDetailed(input: RouteInput): Promise<SemanticResult> {
  if (input.forceTier) return { tier: input.forceTier };
  if (input.hasImages || (input.images?.length ?? 0) > 0) return { tier: 'vision' };

  const { refs } = await ensureRefs();
  const { embedding } = await embed({
    model: gateway.textEmbeddingModel(EMBED_MODEL),
    value: input.prompt,
  });

  const best: Record<TextTier, number> = { fast: -Infinity, reasoning: -Infinity, coding: -Infinity };
  for (const r of refs) {
    const s = cosine(embedding, r.vec);
    if (s > best[r.tier]) best[r.tier] = s;
  }

  let winner: TextTier = 'fast';
  for (const tier of Object.keys(best) as TextTier[]) {
    if (best[tier] > best[winner]) winner = tier;
  }
  return { tier: winner, score: best[winner], scores: best };
}

/** Classify a request into a tier using embeddings. Drop-in async analog of classify(). */
export async function classifySemantic(input: RouteInput): Promise<TaskTier> {
  return (await classifySemanticDetailed(input)).tier;
}
