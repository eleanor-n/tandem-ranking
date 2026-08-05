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
import {
  GLOBAL_QUALITY_MULTIPLIER_COUNT,
  MULTIPLICATIVE_LEAVES,
  PJOIN_SUMMANDS,
} from '../src/ranking/core/score.js';

const CORE = join(import.meta.dirname, '..', 'src', 'ranking', 'core');

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

  it('does not call a host-only term pairwise just because it takes a viewer', () => {
    // The self-deception this file exists to stop. `acceptLikelihood(viewer, c)`
    // has a `viewer` parameter and reads exactly one bit off it — verification
    // status, worth a x1.05 nudge. That is not two-sidedness. It is classified
    // by what it DEPENDS ON, which today is the host.
    //
    // When §1.2 makes it genuinely conditional on the asker, this expectation
    // flips, and the diff is the repair.
    expect(TERM_CLASS.acceptLikelihood).toBe('global_quality');
    expect(TERM_CLASS.hostReliability).toBe('global_quality');
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

describe('the guard fires on the current score', () => {
  it('flags exactly the four terms v1.7 D3 measured', () => {
    // This test documents a DEFECT THAT IS STILL PRESENT. It is not a green
    // check mark. §1.2-1.4 shrink this list; when it is empty the assertion
    // below becomes `not.toThrow()` and the load-time guard is switched on.
    const offenders = MULTIPLICATIVE_LEAVES.filter(
      (t) => TERM_CLASS[t] === 'global_quality',
    );

    expect(offenders.sort()).toEqual([
      'acceptLikelihood',
      'completionPrior',
      'freshness',
      'repeatableContext',
    ]);

    expect(() => assertNoGlobalQualityMultipliers(MULTIPLICATIVE_LEAVES))
      .toThrow(/Global-quality terms used as raw score multipliers/);
  });

  it('pins the violation count so it can shrink but never grow', () => {
    expect(GLOBAL_QUALITY_MULTIPLIER_COUNT).toBeLessThanOrEqual(4);
  });

  it('passes cleanly once the global-quality terms are gone', () => {
    // The guard itself works — proven against a hypothetical repaired list, so
    // that "it throws" above is not merely a function that always throws.
    const repaired: TermName[] = ['rhythmOverlap', 'exposureBoost', 'demandMultiplier'];
    expect(() => assertNoGlobalQualityMultipliers(repaired)).not.toThrow();
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
    const known = new Set<string>([...MULTIPLICATIVE_LEAVES, ...PJOIN_SUMMANDS]);

    for (const feature of accessed) {
      expect(
        known.has(feature),
        `score.ts reads f.${feature}, which is in neither MULTIPLICATIVE_LEAVES ` +
        'nor PJOIN_SUMMANDS. Classify it and declare where it enters the score.',
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
