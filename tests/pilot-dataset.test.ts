/**
 * Structural validation for the PILOT dataset (eval/pilot-dataset.ts).
 *
 * These tests are hermetic and offline: they only assert invariants of the
 * dataset itself (shape, counts, tier/subtype/split coverage, vision-by-image
 * rule) and its independence from the two sources it must not duplicate —
 * eval/dataset.ts and the semantic-classifier reference utterances.
 *
 * They do NOT run the classifier and never touch the holdout split's
 * predictions. Holdout cases exist to be scored once, later, untouched.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { PILOT_CASES, PILOT_SUBTYPES, type PilotSplit } from '../eval/pilot-dataset';
import { EVAL_CASES } from '../eval/dataset';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const TIERS = ['fast', 'reasoning', 'vision', 'coding'] as const;
const SPLITS: PilotSplit[] = ['validation', 'holdout'];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

const hasImageInput = (c: { images?: unknown[]; hasImages?: boolean }) =>
  c.hasImages === true || (Array.isArray(c.images) && c.images.length > 0);

const countBy = <T extends string>(values: T[]): Record<string, number> =>
  values.reduce<Record<string, number>>((acc, v) => {
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});

/** Single-quoted string literals in the semantic classifier source. */
function referenceUtterances(): string[] {
  const src = readFileSync(resolve(REPO, 'src/semantic-classifier.ts'), 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/'([^'\\]{6,})'/g)) out.push(m[1]);
  return out;
}

describe('pilot dataset — shape', () => {
  it('has exactly 100 cases', () => {
    expect(PILOT_CASES).toHaveLength(100);
  });

  it('uses unique ids and unique normalized prompts', () => {
    const ids = PILOT_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);

    const prompts = PILOT_CASES.map((c) => norm(c.prompt));
    expect(new Set(prompts).size).toBe(prompts.length);
  });

  it('labels every case with one of the four TaskTier values', () => {
    for (const c of PILOT_CASES) {
      expect(TIERS).toContain(c.expected);
      expect(c.prompt.length).toBeGreaterThan(2);
      expect(c.split === 'validation' || c.split === 'holdout').toBe(true);
    }
  });

  it('covers at least 8 task subtypes, each with at least 8 cases', () => {
    expect(PILOT_SUBTYPES.length).toBeGreaterThanOrEqual(8);

    for (const st of PILOT_SUBTYPES) {
      const n = PILOT_CASES.filter((c) => c.subtype === st).length;
      expect(n, `subtype ${st}`).toBeGreaterThanOrEqual(8);
    }
    // No case may carry a subtype outside the declared registry.
    const declared = new Set<string>(PILOT_SUBTYPES);
    for (const c of PILOT_CASES) expect(declared.has(c.subtype)).toBe(true);
  });
});

describe('pilot dataset — splits', () => {
  it('splits 60 validation / 40 untouched holdout', () => {
    const bySplit = countBy(PILOT_CASES.map((c) => c.split));
    expect(bySplit.validation).toBe(60);
    expect(bySplit.holdout).toBe(40);
  });

  it('keeps both splits representative of tiers and subtypes', () => {
    for (const split of SPLITS) {
      const inSplit = PILOT_CASES.filter((c) => c.split === split);
      const tiers = new Set(inSplit.map((c) => c.expected));
      expect(tiers.size, `${split} tiers`).toBe(4);
      expect(new Set(inSplit.map((c) => c.subtype)).size).toBeGreaterThanOrEqual(8);
    }
  });

  it('has no case with an unknown split', () => {
    for (const c of PILOT_CASES) expect(SPLITS).toContain(c.split);
  });
});

describe('pilot dataset — vision by image presence', () => {
  it('gives every vision case an image input', () => {
    for (const c of PILOT_CASES.filter((c) => c.expected === 'vision')) {
      expect(hasImageInput(c), c.id).toBe(true);
    }
  });

  it('gives no non-vision case an image input', () => {
    for (const c of PILOT_CASES.filter((c) => c.expected !== 'vision')) {
      expect(hasImageInput(c), c.id).toBe(false);
    }
  });
});

describe('pilot dataset — annotation hygiene', () => {
  it('flags and annotates adversarial and ambiguous cases', () => {
    for (const c of PILOT_CASES) {
      if (c.adversarial || c.ambiguous) {
        expect(c.note, `${c.id} needs a note`).toBeTruthy();
      }
    }
    expect(PILOT_CASES.filter((c) => c.adversarial).length).toBeGreaterThanOrEqual(8);
    expect(PILOT_CASES.filter((c) => c.ambiguous).length).toBeGreaterThanOrEqual(5);
  });
});

describe('pilot dataset — independence from existing eval + references', () => {
  it('shares no prompt (exactly) with eval/dataset.ts', () => {
    const old = new Set(EVAL_CASES.map((c) => norm(c.prompt)));
    const clashes = PILOT_CASES.filter((c) => old.has(norm(c.prompt))).map((c) => c.id);
    expect(clashes).toEqual([]);
  });

  it('shares no id with eval/dataset.ts', () => {
    const old = new Set(EVAL_CASES.map((c) => c.id));
    expect(PILOT_CASES.filter((c) => old.has(c.id))).toEqual([]);
  });

  it('does not copy any semantic reference utterance verbatim', () => {
    const refs = new Set(referenceUtterances().map(norm));
    const clashes = PILOT_CASES.filter((c) => refs.has(norm(c.prompt))).map((c) => c.id);
    expect(clashes).toEqual([]);
  });
});
