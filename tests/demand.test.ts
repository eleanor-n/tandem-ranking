/**
 * Demand balancing (§2) and exhaustion (§3).
 *
 * The property under test throughout: both terms must vanish as their resolved
 * parameters go to zero, and both must be monotonic in the thing they claim to
 * measure. A demand signal that is not monotonic in fill is not a demand signal.
 */

import { describe, expect, it } from 'vitest';
import {
  demandAdjustment,
  exhaustion,
  fillRatio,
  overflow,
  repeatAffinity,
  timePressure,
  urgency,
} from '../src/ranking/core/demand.js';
import { resolveParams } from '../src/ranking/core/regime.js';
import { CONSTANTS } from '../src/ranking/core/constants.js';
import { DAY, T0, makeCandidate, makeViewer } from './fixtures/index.js';

const village = resolveParams(0);
const city = resolveParams(1);
const viewer = makeViewer();

/**
 * v1.7: exhaustion SHIPS OFF (CONSTANTS.collapsed.exhaustionRate is 0), because
 * `repeatAffinity` has no data and the term therefore damps good repeats and
 * bad ones identically — against the very metric it exists to serve.
 *
 * The mechanism is not deleted, so it is still tested here at the rates it will
 * be reactivated with. That is the difference between shelving something and
 * abandoning it: these tests keep running, so the day check-ins ship the code
 * still works.
 */
const reactivatedRate = CONSTANTS.collapsed.exhaustionRateWhenReactivated;
const villageX = { ...village, exhaustionRate: reactivatedRate };
const cityX = { ...city, exhaustionRate: reactivatedRate * 0.5 };

const post = (over: Parameters<typeof makeCandidate>[0]) => makeCandidate(over);

describe('fillRatio', () => {
  it('defaults capacity to 1 — a tandem is two people', () => {
    expect(fillRatio(post({ activityId: 'a', confirmedJoiners: 0 }))).toBe(0);
    expect(fillRatio(post({ activityId: 'a', confirmedJoiners: 1 }))).toBe(1);
    expect(fillRatio(post({ activityId: 'a', confirmedJoiners: 3 }))).toBe(3);
  });

  it('honours an explicit capacity', () => {
    expect(fillRatio(post({
      activityId: 'a', confirmedJoiners: 2, targetJoiners: 4,
    }))).toBe(0.5);
  });

  it('distinguishes unknown from zero', () => {
    // The important one. If unknown read as zero, every post whose joiner count
    // failed to load would be boosted as if it were desperately empty.
    expect(fillRatio(post({ activityId: 'a' }))).toBeNull();
    expect(urgency(post({ activityId: 'a', startsAt: T0 + DAY }), T0)).toBe(0);
    expect(overflow(post({ activityId: 'a' }))).toBe(0);
  });
});

describe('urgency', () => {
  it('is maximal for an empty post happening tomorrow', () => {
    const u = urgency(post({
      activityId: 'a', confirmedJoiners: 0, startsAt: T0 + DAY,
    }), T0);
    expect(u).toBeGreaterThan(0.8);
  });

  it('is zero for a post that is already full', () => {
    expect(urgency(post({
      activityId: 'a', confirmedJoiners: 1, startsAt: T0 + DAY,
    }), T0)).toBe(0);
    // And still zero when over-full.
    expect(urgency(post({
      activityId: 'a', confirmedJoiners: 5, startsAt: T0 + DAY,
    }), T0)).toBe(0);
  });

  it('decays with lead time but never to zero', () => {
    const near = urgency(post({ activityId: 'a', confirmedJoiners: 0, startsAt: T0 + DAY }), T0);
    const far = urgency(post({ activityId: 'a', confirmedJoiners: 0, startsAt: T0 + 30 * DAY }), T0);
    expect(far).toBeLessThan(near);
    expect(far).toBeCloseTo(CONSTANTS.demand.timePressureFloor, 10);
  });

  it('is monotonic decreasing in fill', () => {
    let previous = Infinity;
    for (const joiners of [0, 1, 2, 3, 4]) {
      const u = urgency(post({
        activityId: 'a', confirmedJoiners: joiners, targetJoiners: 4, startsAt: T0 + DAY,
      }), T0);
      expect(u).toBeLessThanOrEqual(previous);
      previous = u;
    }
  });

  it('timePressure is clamped at both ends', () => {
    // A post that already started.
    expect(timePressure(post({ activityId: 'a', startsAt: T0 - 5 * DAY }), T0)).toBe(1);
    expect(timePressure(post({ activityId: 'a', startsAt: T0 + 365 * DAY }), T0))
      .toBe(CONSTANTS.demand.timePressureFloor);
  });
});

describe('overflow', () => {
  it('is zero until the post is actually full', () => {
    expect(overflow(post({ activityId: 'a', confirmedJoiners: 0 }))).toBe(0);
    expect(overflow(post({ activityId: 'a', confirmedJoiners: 1 }))).toBe(0);
    expect(overflow(post({ activityId: 'a', confirmedJoiners: 2 }))).toBe(1);
  });
});

describe('exhaustion', () => {
  it('is zero for a host you have never met', () => {
    expect(exhaustion(post({ activityId: 'a' }), villageX)).toBe(0);
    expect(exhaustion(post({ activityId: 'a', completedTogether: 0 }), villageX)).toBe(0);
  });

  it('saturates rather than growing linearly', () => {
    const p = (n: number) => exhaustion(post({ activityId: 'a', completedTogether: n }), villageX);
    const first = p(1) - p(0);
    const tenth = p(10) - p(9);
    expect(tenth).toBeLessThan(first);
    expect(p(100)).toBeLessThan(1);
  });

  it('is monotone in the rate', () => {
    const c = post({ activityId: 'a', completedTogether: 3 });
    expect(exhaustion(c, villageX)).toBeGreaterThan(exhaustion(c, cityX));
  });
});

describe('repeatAffinity gating', () => {
  it('vanishes entirely for a host you keep saying yes to', () => {
    // The load-bearing case. Becoming a habit with someone is the north star,
    // so exhaustion must not punish the pairings that are working.
    const loved = post({ activityId: 'a', completedTogether: 5, repeatAffinity: 1 });
    const adjustment = demandAdjustment(viewer, loved, T0, villageX);
    expect(adjustment.exhaustion).toBeGreaterThan(0.5);   // they ARE exhausted
    expect(adjustment.multiplier).toBe(1);                 // and it costs nothing
  });

  it('suppresses hardest for a host you said no to', () => {
    const base = { activityId: 'a', completedTogether: 3 } as const;
    const said_no = demandAdjustment(viewer, post({ ...base, repeatAffinity: 0 }), T0, villageX);
    const unknown = demandAdjustment(viewer, post({ ...base }), T0, villageX);
    const said_yes = demandAdjustment(viewer, post({ ...base, repeatAffinity: 1 }), T0, villageX);

    expect(said_no.multiplier).toBeLessThan(unknown.multiplier);
    expect(unknown.multiplier).toBeLessThan(said_yes.multiplier);
  });

  it('defaults to neutral when there is no check-in answer', () => {
    // Currently the case for EVERY pairing, since check-in data does not exist
    // yet. Documented as a known temporary weakness, not a design choice.
    expect(repeatAffinity(post({ activityId: 'a' })))
      .toBe(CONSTANTS.demand.unknownRepeatAffinity);
    expect(repeatAffinity(post({ activityId: 'a', repeatAffinity: Number.NaN })))
      .toBe(CONSTANTS.demand.unknownRepeatAffinity);
  });
});

describe('exhaustion ships disabled (v1.7 §3.1)', () => {
  it('is zero at every point on the continuum', () => {
    // Not "small". Zero. `repeatAffinity` has no data, so the term cannot tell
    // a good repeat from a bad one and damps both by the same amount — and
    // repeat-tandem rate is the long-run north star. A uniform damper on the
    // thing you are optimising for is worse than no damper at all.
    for (let r = 0; r <= 1.0001; r += 0.05) {
      expect(resolveParams(r).exhaustionRate).toBe(0);
    }
  });

  it('makes a fifty-time repeat cost exactly nothing today', () => {
    const worn = post({ activityId: 'a', completedTogether: 50, repeatAffinity: 0 });
    const adjustment = demandAdjustment(viewer, worn, T0, village);
    expect(adjustment.exhaustion).toBe(0);
    expect(adjustment.multiplier).toBe(1);
  });

  it('keeps the tuned rate parked for reactivation', () => {
    // Shelved, not abandoned. The reactivation condition is stated in exactly
    // one place (constants.ts) and the number is not lost with it.
    expect(reactivatedRate).toBeGreaterThan(0);
  });
});

describe('the combined adjustment', () => {
  it('boosts an empty imminent post, in proportion to demandWeight', () => {
    // v1.7 asserted village > city here. v1.8 §2 collapsed demandWeight to a
    // single constant, so the comparison that remains is against the parameter
    // rather than against a density that no longer varies.
    const desperate = post({ activityId: 'a', confirmedJoiners: 0, startsAt: T0 + DAY });
    const shipped = demandAdjustment(viewer, desperate, T0, village).multiplier;
    const stronger = demandAdjustment(
      viewer, desperate, T0, { ...village, demandWeight: village.demandWeight * 5 },
    ).multiplier;

    expect(shipped).toBeGreaterThan(1);
    expect(stronger).toBeGreaterThan(shipped);
  });

  it('is inert when every term is absent', () => {
    // Village behaviour is the limit of city behaviour, and BOTH are the limit
    // of "no demand data" — nothing here may fire on missing information.
    expect(demandAdjustment(viewer, post({ activityId: 'a' }), T0, village).multiplier).toBe(1);
    expect(demandAdjustment(viewer, post({ activityId: 'a' }), T0, city).multiplier).toBe(1);
  });

  it('never multiplies a card to zero', () => {
    // The score orders and never filters. A zeroed card is indistinguishable
    // from an ineligible one and sorts arbitrarily against its equally-zeroed
    // peers.
    const worst = post({
      activityId: 'a',
      confirmedJoiners: 99,
      completedTogether: 500,
      repeatAffinity: 0,
      startsAt: T0 + 365 * DAY,
    });
    const m = demandAdjustment(viewer, worst, T0, villageX).multiplier;
    expect(m).toBeGreaterThan(0);
    expect(m).toBeGreaterThanOrEqual(CONSTANTS.demand.multiplierFloor);
  });

  it('reports its components for debugging', () => {
    const a = demandAdjustment(viewer, post({
      activityId: 'a', confirmedJoiners: 0, completedTogether: 2, startsAt: T0 + DAY,
    }), T0, villageX);
    expect(a.urgency).toBeGreaterThan(0);
    expect(a.overflow).toBe(0);
    expect(a.exhaustion).toBeGreaterThan(0);
  });
});
