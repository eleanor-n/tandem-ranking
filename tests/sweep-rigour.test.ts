/**
 * Architectural tests on the DIAGNOSTIC HARNESS itself.
 *
 * The repo's stated principle is that a constraint worth keeping is a test
 * rather than a comment, because "a comment saying do not import React here
 * survives exactly one distracted afternoon". That principle was applied to
 * `src/` and not to `scripts/`, and the harness is where the reasoning failure
 * actually happened:
 *
 *   v1.7 §D4  a three-seed verdict inverted at six seeds
 *   -> built a 2 SE gate, with a comment explaining why maxima are not findings
 *   -> wired the gate to `retentionAfterEmpty`
 *   -> changed the primary metric to `hostRetention` in the same build
 *   -> `hostRetention` had no standard error computed anywhere
 *   -> v1.8 ranked four arms across a 0.040 span with no error bars
 *
 * Every step was individually reasonable. The comment did not stop it. These
 * tests are an attempt to make the next version of that sequence fail loudly.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const sweepPath = resolve(here, '../scripts/sweep.ts');
const source = readFileSync(sweepPath, 'utf8');

/** Strip comments and string literals, so doc prose cannot satisfy a check. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const body = code(source);

/** The metric names declared in SE_METRICS. */
function declaredSeMetrics(): string[] {
  const block = /const SE_METRICS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(source);
  expect(block, 'SE_METRICS must exist and be a literal array').toBeTruthy();
  return [...(block as RegExpExecArray)[1]!.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1] as string);
}

describe('every reported metric carries a standard error', () => {
  it('SE_METRICS includes the PRIMARY metric', () => {
    // The exact omission that produced the v1.8 table. `hostRetention` is
    // declared THE PRIMARY METRIC in the Result interface and had no SE.
    expect(declaredSeMetrics()).toContain('hostRetention');
  });

  it('SE_METRICS includes every metric the fairness and liquidity claims rest on', () => {
    const required = ['hostGini', 'zeroJoinerRate', 'deckRelevance', 'survivingHostFraction'];
    const declared = declaredSeMetrics();
    for (const m of required) expect(declared, `${m} has no SE`).toContain(m);
  });

  it('the markdown table renders the primary metric WITH its error bar', () => {
    // `pm(x, se)` is the "0.970 ±0.003" formatter. A metric printed with plain
    // n3() in the headline table is a metric being reported as if exact.
    //
    // Read from `source`, not `body`: the table cells are template literals and
    // `code()` blanks those out.
    const table = /function markdownTable[\s\S]*?\n}/.exec(source)?.[0] ?? '';
    expect(table).toContain('pm(row.hostRetention');
    expect(table).toContain('pm(row.hostGini');
    expect(table).not.toMatch(/n3\(row\.hostRetention\)/);
  });
});

describe('comparisons are gated, not asserted', () => {
  it('the "loses to random" alarm goes through separates(), not a bare <', () => {
    // It used to be `row.hostRetention < random.hostRetention`, which is how it
    // printed "0.833 vs 0.833" as a suspected bug.
    // The whole guard block, from the loop that finds `random` to the alarm.
    const guard = /const random = aggregates\.find[\s\S]*?BUG SUSPECTED[\s\S]{0,400}/
      .exec(source)?.[0] ?? '';
    expect(guard, 'the random-guard block was not found at all').not.toBe('');
    expect(guard).toContain('separates(');
    // And the bare comparison is gone from the alarm's condition.
    expect(guard).not.toMatch(/if\s*\(row\s*&&\s*row\.hostRetention\s*<\s*random\.hostRetention\)/);
  });

  it('separates() is two-sample — the bar is sqrt(sa^2 + sb^2), not one arm alone', () => {
    const fn = /function separates\([\s\S]*?\n}/.exec(body)?.[0] ?? '';
    expect(fn).toMatch(/Math\.sqrt\(\s*a\.se\[metric\]\s*\*\*\s*2\s*\+\s*b\.se\[metric\]\s*\*\*\s*2\s*\)/);
  });

  it('podium() refuses to name a winner out of a tie', () => {
    const fn = /function podium\([\s\S]*?\n}/.exec(source)?.[0] ?? '';
    expect(fn).toContain('NOT IDENTIFIED');
  });
});

describe('the CSV is a data artifact, not a display one', () => {
  it('writes more precision than the markdown table', () => {
    // podium.ts does arithmetic on these columns. At 3dp it was deciding a
    // 1.02x separation margin in a digit the file did not carry.
    const csvFn = /function csv\([\s\S]*?\n}/.exec(body)?.[0] ?? '';
    expect(csvFn).toContain('n6(r.hostRetention)');
    expect(csvFn).not.toMatch(/n3\(r\.hostRetention\)/);
  });

  it('emits an se_ column for every declared SE metric', () => {
    // Both the header and the row must be generated FROM SE_METRICS, so that
    // adding a metric cannot add a mean without its error bar.
    const csvFn = /function csv\([\s\S]*?\n}/.exec(source)?.[0] ?? '';
    const generated = csvFn.match(/SE_METRICS\.map/g) ?? [];
    expect(generated.length, 'header and rows must both derive from SE_METRICS')
      .toBeGreaterThanOrEqual(2);
    expect(csvFn).toContain('se_${m}');
  });
});

describe('a run records the configuration it actually used', () => {
  it('prints whether each funnel parameter was pinned or inherited', () => {
    // A 24-seed run was launched, constants.ts was edited an hour later as part
    // of the §1.5 abort, and the ablation invocations that had not started yet
    // would have silently picked up the new value — producing a comparison
    // table across two different configurations with nothing saying so.
    expect(source).toContain('effective funnel config');
    const block = /effective funnel config[\s\S]{0,900}/.exec(source)?.[0] ?? '';
    for (const p of ['opts.rho', 'opts.repeatableContextWeight', 'opts.demandWeight',
                     'opts.funnelExponent']) {
      expect(block, `${p} is not reported in the effective config`).toContain(p);
    }
    // And it must distinguish the two cases, or it is just an echo of the flags.
    expect(source).toContain('(pinned)');
    expect(source).toContain('(from constants)');
  });
});
