/**
 * The regime module, tested in isolation.
 *
 * The property that matters most here is not any individual number — it is that
 * there is no discontinuity anywhere on the continuum. A parameter that jumps
 * is a mode switch wearing a coefficient's clothes.
 */

import { describe, expect, it } from 'vitest';
import {
  applyHysteresis,
  computeRegime,
  coverageOf,
  paramsFingerprint,
  regimeFromCoverage,
  resolve,
  resolveParams,
  updateCoverageEwma,
} from '../src/ranking/core/regime.js';
import { CONSTANTS } from '../src/ranking/core/constants.js';

describe('coverage', () => {
  it('is eligible posts over cards viewed', () => {
    expect(coverageOf({
      eligiblePostsPerWeek: 40, cardsViewedPerWeek: 20, weeksOfHistory: 4,
    })).toBe(2);
  });

  it('falls back to the default view rate without enough history', () => {
    const { defaultCardsViewedPerWeek, minWeeksOfHistory } = CONSTANTS.regime;

    // Measured rate present but history too short -> ignored.
    expect(coverageOf({
      eligiblePostsPerWeek: 30,
      cardsViewedPerWeek: 3,
      weeksOfHistory: minWeeksOfHistory - 1,
    })).toBe(30 / defaultCardsViewedPerWeek);

    // No measurement at all -> same fallback.
    expect(coverageOf({
      eligiblePostsPerWeek: 30, cardsViewedPerWeek: null, weeksOfHistory: 9,
    })).toBe(30 / defaultCardsViewedPerWeek);
  });

  it('never divides by zero', () => {
    expect(Number.isFinite(coverageOf({
      eligiblePostsPerWeek: 10, cardsViewedPerWeek: 0, weeksOfHistory: 9,
    }))).toBe(true);
  });

  it('an empty pool is fully village, not NaN', () => {
    const c = coverageOf({
      eligiblePostsPerWeek: 0, cardsViewedPerWeek: 20, weeksOfHistory: 9,
    });
    expect(regimeFromCoverage(c)).toBe(0);
  });
});

describe('smoothing', () => {
  it('seeds from the first observation rather than from zero', () => {
    // Seeding from 0 would drag a genuinely dense user into village mode for
    // several weeks after install.
    expect(updateCoverageEwma(null, 3.2)).toBe(3.2);
  });

  it('moves toward the new value by alpha', () => {
    const a = CONSTANTS.regime.coverageEwmaAlpha;
    expect(updateCoverageEwma(2, 4)).toBeCloseTo(a * 4 + (1 - a) * 2, 12);
  });

  it('converges to a sustained value', () => {
    let ewma: number | null = null;
    for (let i = 0; i < 40; i++) ewma = updateCoverageEwma(ewma, 5);
    expect(ewma).toBeCloseTo(5, 6);
  });
});

describe('hysteresis', () => {
  const band = CONSTANTS.regime.hysteresisBand;

  it('holds the previous regime for a move inside the band', () => {
    expect(applyHysteresis(0.5 + band * 0.5, 0.5)).toBe(0.5);
    expect(applyHysteresis(0.5 - band * 0.5, 0.5)).toBe(0.5);
  });

  it('moves for a change larger than the band', () => {
    const candidate = 0.5 + band * 2;
    expect(applyHysteresis(candidate, 0.5)).toBe(candidate);
  });

  it('does not hold on the first ever reading', () => {
    expect(applyHysteresis(0.8, null)).toBe(0.8);
  });

  it('reports when it suppressed a move', () => {
    const reading = computeRegime(
      { eligiblePostsPerWeek: 55, cardsViewedPerWeek: 20, weeksOfHistory: 9 },
      { coverageEwma: 2.7, lastRegime: 0.48, updatedAt: null },
    );
    expect(reading.held).toBe(true);
    expect(reading.regime).toBe(0.48);
  });

  it('does not ratchet — a sustained drop converges to within the band', () => {
    // Hysteresis must resist noise, not resist reality. It cannot converge
    // exactly: by construction the emitted value may sit up to one band away
    // from the truth forever. Bounded error is the price of not flip-flopping.
    let state = { coverageEwma: 6, lastRegime: 1, updatedAt: null };
    let regime = 1;
    for (let week = 0; week < 30; week++) {
      const reading = computeRegime(
        { eligiblePostsPerWeek: 10, cardsViewedPerWeek: 20, weeksOfHistory: 9 },
        state,
      );
      regime = reading.regime;
      state = { coverageEwma: reading.coverageEwma, lastRegime: regime, updatedAt: null };
    }
    expect(regime).toBeLessThanOrEqual(CONSTANTS.regime.hysteresisBand);
  });
});

describe('the regime scalar', () => {
  it('is 0 at or below the low bound and 1 at or above the high bound', () => {
    expect(regimeFromCoverage(CONSTANTS.regime.coverageLow)).toBe(0);
    expect(regimeFromCoverage(CONSTANTS.regime.coverageLow - 5)).toBe(0);
    expect(regimeFromCoverage(CONSTANTS.regime.coverageHigh)).toBe(1);
    expect(regimeFromCoverage(CONSTANTS.regime.coverageHigh + 100)).toBe(1);
  });

  it('is monotonic in coverage', () => {
    let previous = -1;
    for (let c = 0; c <= 8; c += 0.1) {
      const r = regimeFromCoverage(c);
      expect(r).toBeGreaterThanOrEqual(previous);
      previous = r;
    }
  });
});

describe('resolveParams is an identity over collapsed constants (v1.8 §2)', () => {
  it('returns the declared constants', () => {
    const p = resolveParams(0.5);
    const c = CONSTANTS.collapsed;

    expect(p.exploreEpsilon).toBe(c.exploreEpsilon);
    expect(p.categoryPenalty).toBe(c.categoryPenalty);
    expect(p.hostPenalty).toBe(c.hostPenalty);
    expect(p.noveltyBoost).toBe(c.noveltyBoost);
    expect(p.demandWeight).toBe(c.demandWeight);
    expect(p.exhaustionRate).toBe(c.exhaustionRate);
    expect(p.overflowPenalty).toBe(c.overflowPenalty);
  });

  it('IGNORES the regime entirely — the property the collapse asserts', () => {
    // Twelve pairs were declared; exactly one was ever swept, and that sweep
    // found the primary metric flat in it. The pairs are shelved rather than
    // trusted, and this is the test that says so unambiguously.
    const reference = JSON.stringify(resolveParams(0));
    for (let r = 0; r <= 1.0001; r += 0.05) {
      expect(JSON.stringify(resolveParams(r)), `regime ${r.toFixed(2)} differed`)
        .toBe(reference);
    }
    // Including nonsense input, which must not throw or produce NaN.
    expect(JSON.stringify(resolveParams(-3))).toBe(reference);
    expect(JSON.stringify(resolveParams(9))).toBe(reference);
    expect(JSON.stringify(resolveParams(Number.NaN))).toBe(reference);
  });

  it('still renormalises P_join to exactly 1', () => {
    const sum = Object.values(resolveParams(0.5).pJoin).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it('still keeps retrieval quotas summing to 1', () => {
    const sum = Object.values(resolveParams(0.5).quotas).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it('keeps graphAffinity at zero weight while the feature is a stub', () => {
    // A non-zero weight on an always-zero feature survives renormalisation and
    // caps P_join below 1 for everyone (INFERENCES §F2).
    expect(resolveParams(0.5).pJoin.graphAffinity).toBe(0);
  });

  it('keeps the session penalties inside (0, 1]', () => {
    // A penalty of 0 would be a hard cap wearing a multiplier's clothes.
    const p = resolveParams(0.5);
    expect(p.categoryPenalty).toBeGreaterThan(0);
    expect(p.categoryPenalty).toBeLessThanOrEqual(1);
    expect(p.hostPenalty).toBeGreaterThan(0);
    expect(p.hostPenalty).toBeLessThanOrEqual(1);
  });

  it('ships exhaustion disabled', () => {
    expect(resolveParams(0.5).exhaustionRate).toBe(0);
    // The tuned value is parked, not lost, so reactivation is a one-line swap.
    expect(CONSTANTS.collapsed.exhaustionRateWhenReactivated).toBeGreaterThan(0);
  });
});

describe('the density machinery survives the collapse', () => {
  // Shelved, not deleted. Coverage, smoothing, hysteresis and the interpolation
  // primitive are all intact and all still tested above and below — they simply
  // have nothing to modulate today. Reactivating a pair is one edit in
  // resolveParams plus turning one constant back into a { village, city }.

  it('still measures coverage and still smooths it', () => {
    const reading = computeRegime(
      { eligiblePostsPerWeek: 80, cardsViewedPerWeek: 20, weeksOfHistory: 9 },
      { coverageEwma: 2, lastRegime: 0.2, updatedAt: null },
    );
    expect(reading.coverage).toBe(4);
    expect(reading.coverageEwma).toBeGreaterThan(2);
    expect(reading.regime).toBeGreaterThanOrEqual(0);
    expect(reading.regime).toBeLessThanOrEqual(1);
  });

  it('still interpolates, for the day a pair earns reactivation', () => {
    expect(resolve({ village: 10, city: 20 }, 0.5)).toBe(15);
  });
});

describe('resolve()', () => {
  it('is a plain lerp with clamped input', () => {
    expect(resolve({ village: 10, city: 20 }, 0)).toBe(10);
    expect(resolve({ village: 10, city: 20 }, 1)).toBe(20);
    expect(resolve({ village: 10, city: 20 }, 0.5)).toBe(15);
    expect(resolve({ village: 10, city: 20 }, 5)).toBe(20);
  });
});

describe('params fingerprint', () => {
  it('is stable now that noveltyBoost is constant', () => {
    // Through v1.7 noveltyBoost moved with density, so a cached interest vector
    // computed under one regime was WRONG under another rather than merely
    // stale (INFERENCES §F6). Collapsing the pairs makes it constant.
    expect(paramsFingerprint(resolveParams(0)))
      .toBe(paramsFingerprint(resolveParams(1)));
  });

  it('is retained rather than removed', () => {
    // It costs one string per cache write and is exactly what would be needed
    // again the day a swept pair earns reactivation. A cache-invalidation bug
    // discovered six months later is not worth the deletion.
    expect(paramsFingerprint(resolveParams(0.5))).toMatch(/^nb:/);
  });
});
