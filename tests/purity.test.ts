/**
 * The framework-independence constraint, enforced rather than documented.
 *
 * `src/ranking/core/` must not reach for React, React Native, Expo, Supabase,
 * a browser global, a Node global, or a clock. This is what makes the module
 * testable, and what protects it from the stack decision it does not need to
 * care about.
 *
 * A comment saying "do not import React here" survives exactly one distracted
 * afternoon. A failing test survives indefinitely.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CORE_DIR = join(import.meta.dirname, '..', 'src', 'ranking', 'core');

function coreFiles(): string[] {
  return readdirSync(CORE_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(CORE_DIR, f));
}

/** Strip comments and string literals so prose about React does not trip this. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('core is framework-agnostic', () => {
  it('imports nothing outside core/', () => {
    for (const file of coreFiles()) {
      const source = readFileSync(file, 'utf8');
      const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string);
      for (const spec of imports) {
        expect(
          spec.startsWith('./'),
          `${file} imports "${spec}" — core/ may only import from core/`,
        ).toBe(true);
      }
    }
  });

  it('touches no clock, no randomness source, and no platform global', () => {
    // Date.now() and new Date() are the ones that actually get written by
    // accident; the rest are here so a future edit cannot quietly add I/O.
    const forbidden: Array<[RegExp, string]> = [
      [/\bDate\s*\.\s*now\b/, 'Date.now() — time must be an injected parameter'],
      [/\bnew\s+Date\b/, 'new Date() — time must be an injected parameter'],
      [/\bMath\s*\.\s*random\b/, 'Math.random() — use the seeded Rng'],
      [/\bperformance\s*\.\s*now\b/, 'performance.now()'],
      [/\bwindow\b/, 'window'],
      [/\bdocument\b/, 'document'],
      [/\bnavigator\b/, 'navigator'],
      [/\blocalStorage\b/, 'localStorage'],
      [/\bAsyncStorage\b/, 'AsyncStorage'],
      [/\bprocess\s*\.\s*env\b/, 'process.env'],
      [/\brequire\s*\(/, 'require()'],
      [/\bfetch\s*\(/, 'fetch()'],
      [/\bconsole\s*\./, 'console — core/ has no logger by design'],
    ];

    for (const file of coreFiles()) {
      const source = code(readFileSync(file, 'utf8'));
      for (const [pattern, why] of forbidden) {
        expect(pattern.test(source), `${file} uses ${why}`).toBe(false);
      }
    }
  });

  it('has no magic numbers outside constants.ts', () => {
    // The rule is "no TUNABLES outside constants.ts". These are not tunables:
    //   0 1 2 -1 0.5   indices, polarity, halving
    //   60 24 1000 ...  unit conversions — facts about time, not choices
    //   16 8            hex radix and pad width in the hash formatter
    //   4294967296 61 32 15 7 14  mulberry32's published constants; changing
    //                             any of them makes it a different, worse PRNG
    const allowed = new Set([
      '0', '1', '2', '-1', '0.5', '100',
      '60', '24', '1000', '60000', '60_000', '3600000', '3_600_000',
      '86400000', '86_400_000', '1e-4',
      '16', '8',
      '4294967296', '61', '15', '7', '14', '32',
    ]);

    for (const file of coreFiles()) {
      if (file.endsWith('constants.ts')) continue;
      const source = code(readFileSync(file, 'utf8'));
      const numbers = [...source.matchAll(/(?<![\w.])(\d[\d_]*(?:\.\d+)?(?:e-?\d+)?)/g)]
        .map((m) => m[1] as string)
        .filter((n) => !allowed.has(n));

      expect(
        numbers,
        `${file} contains numeric literals that belong in constants.ts: ${numbers.join(', ')}`,
      ).toEqual([]);
    }
  });
});

describe('the regime boundary', () => {
  // v1.6 §1.4. resolveParams() is the LAST place the density scalar exists.
  // Everything downstream receives plain numbers. If a scoring module could
  // import the regime module, one of them would eventually reach past the
  // resolved values for the scalar itself and branch on it — which is exactly
  // the mode switch this whole design exists to avoid.
  const SEALED = ['score.ts', 'slate.ts', 'explain.ts', 'retrieval.ts', 'features.ts', 'demand.ts'];

  it('no scoring module imports the regime module', () => {
    for (const file of SEALED) {
      const source = readFileSync(join(CORE_DIR, file), 'utf8');
      expect(
        /from\s+'\.\/regime\.js'/.test(source),
        `${file} imports ./regime.js — it must take ResolvedParams instead`,
      ).toBe(false);
    }
  });

  it('no scoring module mentions the regime by name', () => {
    // Catches the subtler version: threading the scalar through as a number and
    // branching on it, without importing anything.
    for (const file of SEALED) {
      const source = code(readFileSync(join(CORE_DIR, file), 'utf8'));
      for (const banned of [/\bregime\b/i, /\bvillage\b/i, /\bcity\b/i, /\bcoverage\b/i]) {
        expect(
          banned.test(source),
          `${file} references ${banned} outside a comment — it must not know density exists`,
        ).toBe(false);
      }
    }
  });

  it('only rank.ts resolves parameters', () => {
    // One resolution point per session. Two would mean two sessions could
    // disagree with themselves mid-deck.
    const callers = readdirSync(CORE_DIR)
      .filter((f) => f.endsWith('.ts') && f !== 'regime.ts')
      .filter((f) => /resolveParams\s*\(/.test(code(readFileSync(join(CORE_DIR, f), 'utf8'))));
    expect(callers).toEqual(['rank.ts']);
  });

  it('the collapsed parameters are declared as single constants (v1.8 §2)', () => {
    // THIS RULE INVERTED IN v1.8. Through v1.7 it asserted the opposite: that
    // each of these was a { village, city } pair, because a fixed value for
    // something the spec said must scale is a regression that typechecks
    // perfectly.
    //
    // §2 collapsed the pairs — twelve were declared, one was ever swept, and
    // that sweep found the primary metric flat in it. So the regression to
    // guard against is now the reverse: a pair reintroduced without the
    // measurement that would justify it.
    //
    // REACTIVATION CONDITION: a swept pair that beats its collapsed constant at
    // 6+ seeds and 2 standard errors. When one earns it, move that name out of
    // this list rather than deleting the check.
    const source = readFileSync(join(CORE_DIR, 'constants.ts'), 'utf8');
    for (const name of [
      'exploreEpsilon', 'categoryPenalty', 'hostPenalty',
      'demandWeight', 'overflowPenalty', 'exhaustionRate', 'noveltyBoost',
    ]) {
      const paired = new RegExp(`^\\s*${name}:\\s*\\{\\s*village`, 'm');
      expect(
        paired.test(source),
        `${name} is declared as a {village, city} pair. v1.8 §2 collapsed these; ` +
        'reintroducing one needs a sweep beating the constant at 6+ seeds and 2 SE.',
      ).toBe(false);
    }
  });
});

describe('the deprecated impression table stays deprecated', () => {
  // v1.7 §1.3. Two tables with overlapping jobs is how a training set ends up
  // split across schemas with no way to join it afterwards. ranking_events won
  // (it has host_id, and it has data); feed_impressions has a DEPRECATED table
  // comment, and this is the half of that decision that cannot be ignored.
  it('nothing in src/ or scripts/ references feed_impressions', () => {
    const roots = [
      join(import.meta.dirname, '..', 'src', 'ranking', 'core'),
      join(import.meta.dirname, '..', 'src', 'ranking', 'adapter'),
      join(import.meta.dirname, '..', 'scripts'),
    ];
    for (const dir of roots) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
        // code() strips comments and string literals, so explaining WHY the
        // table is deprecated is fine; naming it in a query is not.
        const source = code(readFileSync(join(dir, f), 'utf8'));
        expect(
          /feed_impressions/.test(source),
          `${f} references feed_impressions — it is deprecated; write ranking_events`,
        ).toBe(false);
      }
    }
  });
});

describe('the ship gate', () => {
  // v1.7 §3.3. One flag, read in one place. The gate is a parameter
  // transformation rather than a branch (see core/shipping.ts), which is what
  // stops the shelved ranker rotting into code that no longer works when the
  // flag flips.
  it('only rank.ts reads the ranker flag', () => {
    const readers = readdirSync(CORE_DIR)
      .filter((f) => f.endsWith('.ts') && f !== 'shipping.ts')
      .filter((f) => /RANKER_ENABLED|applyShipGate/.test(
        code(readFileSync(join(CORE_DIR, f), 'utf8')),
      ));
    expect(readers).toEqual(['rank.ts']);
  });

  it('no scoring module imports the shipping module', () => {
    // Same rule as the regime boundary, for the same reason: a scoring module
    // that can see the flag will eventually branch on it.
    const sealed = ['score.ts', 'slate.ts', 'explain.ts', 'retrieval.ts', 'features.ts', 'demand.ts'];
    for (const file of sealed) {
      const source = readFileSync(join(CORE_DIR, file), 'utf8');
      expect(
        /from\s+'\.\/shipping\.js'/.test(source),
        `${file} imports ./shipping.js — it must take ResolvedParams instead`,
      ).toBe(false);
    }
  });

  it('the diagnostics parameter override is never used by application code', () => {
    // paramsOverride exists so an offline sweep can vary one weight without the
    // edit-run-revert dance, which leaves no trace in a diff and is therefore
    // indistinguishable from tuning. In app code it would be a constant.
    const adapterDir = join(import.meta.dirname, '..', 'src', 'ranking', 'adapter');
    for (const f of readdirSync(adapterDir).filter((x) => x.endsWith('.ts'))) {
      const source = code(readFileSync(join(adapterDir, f), 'utf8'));
      expect(
        /paramsOverride\s*:/.test(source),
        `${f} sets paramsOverride — that field is for diagnostics only`,
      ).toBe(false);
    }
  });
});

describe('adapter boundary', () => {
  it('only adapter/supabase.ts is coupled to the Supabase client API', () => {
    // index.ts re-exports the factory by name, which is fine. What must not
    // leak is the client itself: no package import, and no query building.
    const adapterDir = join(import.meta.dirname, '..', 'src', 'ranking', 'adapter');
    for (const f of readdirSync(adapterDir).filter((x) => x.endsWith('.ts'))) {
      if (f === 'supabase.ts') continue;
      const source = code(readFileSync(join(adapterDir, f), 'utf8'));
      expect(/@supabase\//.test(source), `${f} imports the Supabase package`).toBe(false);
      expect(/\.from\s*\(/.test(source), `${f} builds a Supabase query`).toBe(false);
    }
  });

  it('nothing anywhere imports the Supabase package', () => {
    // Zero runtime deps is only true if the client stays structurally typed.
    const roots = [
      join(import.meta.dirname, '..', 'src', 'ranking', 'core'),
      join(import.meta.dirname, '..', 'src', 'ranking', 'adapter'),
    ];
    for (const dir of roots) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
        const source = readFileSync(join(dir, f), 'utf8');
        expect(/from\s+'@supabase\//.test(source), `${f} imports @supabase/*`).toBe(false);
      }
    }
  });

  it('declares no runtime dependencies', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});
