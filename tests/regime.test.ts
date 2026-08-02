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

describe('resolveParams', () => {
  it('reproduces the declared village and city columns', () => {
    const village = resolveParams(0);
    const city = resolveParams(1);
    const s = CONSTANTS.scaled;

    expect(village.exploreEpsilon).toBe(s.exploreEpsilon.village);
    expect(city.exploreEpsilon).toBe(s.exploreEpsilon.city);
    expect(village.categoryPenalty).toBe(s.categoryPenalty.village);
    expect(city.categoryPenalty).toBe(s.categoryPenalty.city);
    expect(village.hostPenalty).toBe(s.hostPenalty.village);
    expect(city.hostPenalty).toBe(s.hostPenalty.city);
    expect(village.noveltyBoost).toBe(s.noveltyBoost.village);
    expect(city.noveltyBoost).toBe(s.noveltyBoost.city);
    expect(village.demandWeight).toBe(s.demandWeight.village);
    expect(city.demandWeight).toBe(s.demandWeight.city);
    expect(village.exhaustionRate).toBe(s.exhaustionRate.village);
    expect(city.exhaustionRate).toBe(s.exhaustionRate.city);
  });

  it('renormalises P_join to exactly 1 at every point on the continuum', () => {
    for (let r = 0; r <= 1.0001; r += 0.01) {
      const p = resolveParams(r);
      const sum = Object.values(p.pJoin).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 12);
    }
  });

  it('keeps retrieval quotas summing to 1 at every point', () => {
    for (let r = 0; r <= 1.0001; r += 0.01) {
      const p = resolveParams(r);
      const sum = Object.values(p.quotas).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 12);
    }
  });

  it('is continuous — no parameter jumps anywhere, with NO exemptions', () => {
    // The whole point of the design. A discontinuity here is a mode switch
    // wearing a coefficient's clothes, and it would be felt by users on one day.
    //
    // v1.7 removed the exemption list. v1.6 had to exempt maxPerCategory and
    // maxPerHost: they were integer counts, so they stepped by 1 and were the
    // one legitimate discontinuity in the system. Replacing them with
    // multiplicative session penalties made every resolved parameter continuous,
    // so this test now covers all of them and lets none through.
    const step = 0.005;

    let previous = resolveParams(0);
    for (let r = step; r <= 1.0001; r += step) {
      const current = resolveParams(r);

      for (const [key, value] of Object.entries(current)) {
        if (typeof value !== 'number') continue;
        const before = (previous as unknown as Record<string, number>)[key] as number;
        const delta = Math.abs(value - before);
        expect(delta, `${key} jumped by ${delta} at regime ${r.toFixed(3)}`)
          .toBeLessThanOrEqual(0.05);
      }

      for (const [key, value] of Object.entries(current.pJoin)) {
        const before = (previous.pJoin as Record<string, number>)[key] as number;
        expect(Math.abs(value - before), `pJoin.${key} jumped at ${r.toFixed(3)}`)
          .toBeLessThan(0.02);
      }

      previous = current;
    }
  });

  it('moves proximity down and interest up as density rises', () => {
    // The simulator's finding, made structural: at low density proximity is the
    // dominant feature and the interest model is mostly variance.
    const village = resolveParams(0);
    const city = resolveParams(1);

    expect(village.pJoin.proximity).toBeGreaterThan(city.pJoin.proximity);
    expect(village.pJoin.interestAffinity).toBeLessThan(city.pJoin.interestAffinity);
    expect(village.pJoin.proximity).toBeGreaterThan(village.pJoin.interestAffinity);
    expect(city.pJoin.interestAffinity).toBeGreaterThan(city.pJoin.proximity);
  });

  it('spends no slots on exploration at village scale', () => {
    const village = resolveParams(0);
    expect(village.exploreEpsilon).toBe(0);
    expect(village.quotas.random).toBe(0);
    expect(village.quotas.fresh_host).toBe(0);
    // All of it goes to the two sources that are actually informative there.
    expect(village.quotas.affinity + village.quotas.proximity).toBeCloseTo(1, 12);
  });

  it('clamps rather than extrapolating out-of-range regimes', () => {
    expect(resolveParams(-3)).toEqual(resolveParams(0));
    expect(resolveParams(9)).toEqual(resolveParams(1));
    expect(resolveParams(Number.NaN)).toEqual(resolveParams(0));
  });

  it('keeps the session penalties weaker at village than at city', () => {
    // You cannot diversify a pool that is not diverse. At village scale,
    // penalising the second coffee when coffee is most of what exists demotes
    // the whole pool uniformly, which is a no-op with extra steps.
    const village = resolveParams(0);
    const city = resolveParams(1);

    expect(village.categoryPenalty).toBeGreaterThan(city.categoryPenalty);
    expect(village.hostPenalty).toBeGreaterThan(city.hostPenalty);
  });

  it('never lets a session penalty reach zero', () => {
    // A penalty of 0 is a hard cap wearing a multiplier's clothes: it drives
    // the score to exactly zero, and a zeroed card is indistinguishable from an
    // ineligible one. The score ORDERS and never filters.
    for (let r = 0; r <= 1.0001; r += 0.01) {
      const p = resolveParams(r);
      expect(p.categoryPenalty).toBeGreaterThan(0);
      expect(p.hostPenalty).toBeGreaterThan(0);
      expect(p.categoryPenalty).toBeLessThanOrEqual(1);
      expect(p.hostPenalty).toBeLessThanOrEqual(1);
    }
  });

  it('keeps graphAffinity at zero weight at both ends this build', () => {
    // A non-zero weight on an always-zero feature survives renormalisation and
    // systematically depresses P_join for everyone.
    expect(resolveParams(0).pJoin.graphAffinity).toBe(0);
    expect(resolveParams(1).pJoin.graphAffinity).toBe(0);
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
  it('changes when the interest-affecting parameter changes', () => {
    // The interest vector depends on noveltyBoost, which moves with density, so
    // a cached vector computed under one regime is wrong under another.
    expect(paramsFingerprint(resolveParams(0)))
      .not.toBe(paramsFingerprint(resolveParams(1)));
    expect(paramsFingerprint(resolveParams(0.5)))
      .toBe(paramsFingerprint(resolveParams(0.5)));
  });
});
