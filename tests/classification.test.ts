/**
 * The architectural guard against the v1.7 §D3 defect — v1.8 §1.1.
 *
 * The defect was not a bug in a function. It was an arithmetic property of the
 * whole score: a viewer-independent quality factor inside a per-viewer product
 * makes every client agree about who deserves attention, and host attention
 * concentrates without anyone deciding it should. Gini 0.931, losing to
 * `random` on host retention, while deck relevance was LOWER than with the
 * terms removed.
 *
 * A property like that cannot be prevented by fixing the function that had it.
 * It comes back the next time someone multiplies in something reasonable-looking
 * — a quality score, a trust score, a "verified host" bonus. So the thing this
 * build ships first is the check, not the fix.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BANNED_AS_MULTIPLIER,
  TERM_CLASS,
  assertNoGlobalQualityMultipliers,
  type TermName,
} from '../src/ranking/core/classification.js';
import { rRepeat } from '../src/ranking/core/score.js';
import { resolveParams } from '../src/ranking/core/regime.js';
import { CONSTANTS } from '../src/ranking/core/constants.js';
import type { FeatureVector } from '../src/ranking/core/types.js';
import {
  DAMPENED_MULTIPLICANDS,
  GATE_TERMS,
  GLOBAL_QUALITY_MULTIPLIER_COUNT,
  MULTIPLICATIVE_LEAVES,
  PJOIN_SUMMANDS,
} from '../src/ranking/core/score.js';

const CORE = join(import.meta.dirname, '..', 'src', 'ranking', 'core');
const RANKER = resolveParams(1);

/** Strip comments and strings, same helper the purity test uses. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('the classification is total and honest', () => {
  it('classifies every feature the vector carries', () => {
    // A feature nobody classified would default to nothing and slip through the
    // guard. The FeatureVector is the authority for what exists.
    const types = readFileSync(join(CORE, 'types.ts'), 'utf8');
    const block = types.slice(
      types.indexOf('export interface FeatureVector'),
      types.indexOf('export interface FunnelScore'),
    );
    const declared = [...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1] as string);

    expect(declared.length).toBeGreaterThan(0);
    for (const feature of declared) {
      expect(TERM_CLASS, `FeatureVector.${feature} is unclassified`)
        .toHaveProperty(feature);
    }
  });

  it('promotes a term only when its dependence actually changed', () => {
    // `acceptLikelihood` was `global_quality` through v1.7: it took a `viewer`
    // argument and read one bit off it, worth a x1.05 nudge. §1.2 moved it to
    // `pairwise`, and the move is earned by the `pickiness` factor rather than
    // by the signature — see the pickiness tests below.
    expect(TERM_CLASS.acceptLikelihood).toBe('pairwise');

    // The host half did NOT get promoted with it. It is still one global number
    // per host; it is admissible only because it no longer appears as a factor
    // of its own.
    expect(TERM_CLASS.hostReliability).toBe('global_quality');
  });

  it('admits a global-quality term as a gate but not as a factor', () => {
    // v1.8 §1.3. A sort key does not compound: it splits the deck into two
    // blocks and orders within them. It cannot make a good host twice as
    // visible on every card the way a multiplier can. So `completionPrior` and
    // `freshness` stay `global_quality` and stay out of the product, while
    // still reaching the deck.
    for (const term of GATE_TERMS) {
      expect(TERM_CLASS[term]).toBe('global_quality');
      expect(MULTIPLICATIVE_LEAVES).not.toContain(term);
    }
  });

  it('separates global ALLOCATION from global QUALITY', () => {
    // "No global multipliers" would be too blunt a rule: it would ban the
    // impression floor and demand balancing, which are the only machinery that
    // pushes back on concentration. A global term ranking items by how good
    // they are is the defect; one ranking them by how under-served they are is
    // the corrective. Opposites.
    expect(TERM_CLASS.exposureBoost).toBe('global_allocation');
    expect(TERM_CLASS.demandMultiplier).toBe('global_allocation');
    expect(BANNED_AS_MULTIPLIER).not.toContain('exposureBoost');
    expect(BANNED_AS_MULTIPLIER).not.toContain('demandMultiplier');
  });
});

describe('the guard is armed and the score passes it', () => {
  it('multiplies no global-quality term', () => {
    // Was four through v1.7 and is now zero. §1.2 restored acceptLikelihood's
    // viewer-dependence, §1.3 turned completionPrior/freshness into a gate,
    // §1.4 moved repeatableContext into the dampened list.
    expect(GLOBAL_QUALITY_MULTIPLIER_COUNT).toBe(0);
    expect(() => assertNoGlobalQualityMultipliers(MULTIPLICATIVE_LEAVES)).not.toThrow();
  });

  it('still throws on a list that reintroduces one', () => {
    // So the pass above is a property of the score, not of a guard that has
    // quietly stopped checking anything.
    const regressed: TermName[] = [...MULTIPLICATIVE_LEAVES, 'completionPrior'];
    expect(() => assertNoGlobalQualityMultipliers(regressed))
      .toThrow(/Global-quality terms used as raw score multipliers/);
  });

  it('runs the guard at module load, not only in this file', () => {
    // score.ts calls it on its own declared list at import time, so a future
    // edit crashes on import rather than shipping. Importing the module here
    // is itself the assertion; it would have thrown above if it were going to.
    const source = readFileSync(join(CORE, 'score.ts'), 'utf8');
    expect(/^assertNoGlobalQualityMultipliers\(MULTIPLICATIVE_LEAVES\);$/m.test(source))
      .toBe(true);
  });
});

describe('the dampened category is provisional, and says so', () => {
  it('holds a term that is still global-quality', () => {
    // Damping does not change what a term DEPENDS ON. A category's
    // repeatability is the same fact for every viewer no matter what power it
    // is raised to. The classification must keep saying so, or "I dampened it"
    // becomes a way to launder any global term into the product.
    expect(DAMPENED_MULTIPLICANDS.length).toBeGreaterThan(0);
    for (const term of DAMPENED_MULTIPLICANDS) {
      expect(TERM_CLASS[term]).toBe('global_quality');
      expect(MULTIPLICATIVE_LEAVES).not.toContain(term);
    }
  });

  it('is genuinely dampened, not nominally', () => {
    // An exponent of 1 would be the raw term with extra vocabulary.
    expect(CONSTANTS.score.repeatableContextDamping).toBeGreaterThanOrEqual(0);
    expect(CONSTANTS.score.repeatableContextDamping).toBeLessThan(1);
  });

  it('can be dropped entirely by one parameter', () => {
    // §3.4's second arm. If keeping it does not pay, the answer is weight 0 —
    // not a smaller exponent, which would only make a global term quieter.
    const kept = rRepeat(
      { repeatableContextRank: 1, rhythmOverlap: 0 } as FeatureVector,
      { ...RANKER, repeatableContextWeight: 0.25 },
    );
    const dropped = rRepeat(
      { repeatableContextRank: 1, rhythmOverlap: 0 } as FeatureVector,
      { ...RANKER, repeatableContextWeight: 0 },
    );
    expect(kept).toBeGreaterThan(dropped);
    expect(dropped).toBe(CONSTANTS.score.rRepeat.base);
  });

  it('leaves the pairwise half of R_repeat untouched', () => {
    const w = CONSTANTS.score.rRepeat;
    const withRhythm = rRepeat(
      { repeatableContextRank: 0, rhythmOverlap: 1 } as FeatureVector,
      { ...RANKER, repeatableContextWeight: 0 },
    );
    expect(withRhythm).toBeCloseTo(w.base + w.rhythmOverlap, 12);
  });
});

describe('the declared list matches the code', () => {
  // A list of multiplicands that has drifted from the expression it describes
  // is worse than no list, because it reads as a guarantee.
  const source = code(readFileSync(join(CORE, 'score.ts'), 'utf8'));

  it('every feature score.ts reads is either summed in P_join or a declared leaf', () => {
    const accessed = new Set(
      [...source.matchAll(/\bf\.(\w+)/g)].map((m) => m[1] as string),
    );
    const known = new Set<string>([
      ...MULTIPLICATIVE_LEAVES, ...PJOIN_SUMMANDS, ...GATE_TERMS,
      ...DAMPENED_MULTIPLICANDS,
    ]);

    for (const feature of accessed) {
      expect(
        known.has(feature),
        `score.ts reads f.${feature}, which is in none of MULTIPLICATIVE_LEAVES, ` +
        'PJOIN_SUMMANDS, GATE_TERMS or DAMPENED_MULTIPLICANDS. Classify it and ' +
        'declare how it enters the deck.',
      ).toBe(true);
    }
  });

  it('P_join sums and does not multiply its constituents', () => {
    // The distinction the whole build turns on. If P_join ever multiplies its
    // terms, a per-viewer sum becomes a per-viewer product and the argument
    // that its constituents are safe stops holding.
    const body = source.slice(
      source.indexOf('export function pJoin'),
      source.indexOf('export function pAccept'),
    );
    expect(body.length).toBeGreaterThan(0);
    // Weights times features, summed. No feature-by-feature products.
    expect(/f\.\w+\s*\*\s*(?:w\.)?\w+\s*\*\s*f\./.test(body)).toBe(false);
    expect(body.includes('+')).toBe(true);
  });

  it('no scoring module imports the classification to branch on it', () => {
    // classification.ts is a declaration and a guard, not a runtime input.
    // A scorer that reads TERM_CLASS would be deciding policy from taxonomy,
    // which puts the taxonomy on the hot path and makes it hard to change.
    for (const file of ['slate.ts', 'retrieval.ts', 'features.ts', 'explain.ts', 'demand.ts']) {
      const other = readFileSync(join(CORE, file), 'utf8');
      expect(
        /from\s+'\.\/classification\.js'/.test(other),
        `${file} imports classification.ts — only score.ts declares its own terms`,
      ).toBe(false);
    }
  });
});
