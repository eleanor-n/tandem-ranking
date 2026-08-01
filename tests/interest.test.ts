/**
 * Interest model tests — the parts that will actually break.
 *
 * Not coverage for its own sake. Each of these pins down a property that
 * someone retuning a constant could silently invert.
 */

import { describe, expect, it } from 'vitest';
import {
  computeInterestState,
  decayFactor,
  isCacheFresh,
  noveltyTerm,
  rankedMetrics,
  rebuildInterestStateFromEvents,
  sat,
} from '../src/ranking/core/interest.js';
import { CONSTANTS } from '../src/ranking/core/constants.js';
import { DAY, T0, makeEvent, spreadEvents } from './fixtures/index.js';

describe('decay', () => {
  it('an event at exactly one half-life contributes half its strength', () => {
    // tandem_completed: weight 1.0, half-life 90 days.
    const halfLife = CONSTANTS.interest.sources.tandem_completed.halfLifeDays;

    const fresh = computeInterestState(
      [makeEvent({ metric: 'coffee', source: 'tandem_completed', createdAt: T0 })],
      T0,
    );
    const aged = computeInterestState(
      [makeEvent({
        metric: 'coffee', source: 'tandem_completed',
        createdAt: T0 - halfLife * DAY,
      })],
      T0,
    );

    const freshRaw = fresh.metrics['coffee']!.rawPositive;
    const agedRaw = aged.metrics['coffee']!.rawPositive;

    expect(agedRaw).toBeCloseTo(freshRaw / 2, 10);
  });

  it('decayFactor is exact at 0, 1 and 2 half-lives, and never amplifies', () => {
    expect(decayFactor(0, 30)).toBe(1);
    expect(decayFactor(30, 30)).toBeCloseTo(0.5, 12);
    expect(decayFactor(60, 30)).toBeCloseTo(0.25, 12);
    // Clock skew on a phone produces future timestamps. They must not amplify.
    expect(decayFactor(-10, 30)).toBe(1);
    // Infinity means "never decays" — the onboarding-style case.
    expect(decayFactor(9999, Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('saturation', () => {
  it('the 40th event moves interest by less than 1% of what the 1st did', () => {
    const k = CONSTANTS.interest.saturationK;
    const first = sat(1, k) - sat(0, k);
    const fortieth = sat(40, k) - sat(39, k);

    expect(fortieth).toBeLessThan(first * 0.01);
  });

  it('sat is monotonic, bounded, and 0.5 at x = k', () => {
    const k = CONSTANTS.interest.saturationK;
    expect(sat(0, k)).toBe(0);
    expect(sat(k, k)).toBeCloseTo(0.5, 12);
    expect(sat(1e9, k)).toBeLessThan(1);
    expect(sat(5, k)).toBeGreaterThan(sat(4, k));
    // Negative evidence is handled separately, not by feeding sat a negative.
    expect(sat(-3, k)).toBe(0);
  });

  it('end to end: interest barely moves between the 39th and 40th real event', () => {
    const at39 = computeInterestState(
      spreadEvents('coffee', 'tandem_completed', 39, 0, 'x'), T0,
    );
    const at40 = computeInterestState(
      spreadEvents('coffee', 'tandem_completed', 40, 0, 'y'), T0,
    );
    const delta = at40.metrics['coffee']!.interest - at39.metrics['coffee']!.interest;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(0.01);
  });
});

describe('novelty', () => {
  it('2 events from 5 days ago outrank 40 events spread over 200 days', () => {
    const events = [
      ...spreadEvents('hiking', 'tandem_completed', 2, 0, 'h').map((e) => ({
        ...e, createdAt: T0 - 5 * DAY,
      })),
      ...spreadEvents('coffee', 'tandem_completed', 40, 200, 'c'),
    ];

    const state = computeInterestState(events, T0);
    const order = rankedMetrics(state).map((m) => m.metric);

    // Coffee has strictly more evidence and still loses, which is the point:
    // the novelty prior is what stops the model deciding someone is "a coffee
    // person" forever.
    expect(state.metrics['coffee']!.interest)
      .toBeGreaterThan(state.metrics['hiking']!.interest);
    expect(order[0]).toBe('hiking');
  });

  it('novelty collapses as evidence accumulates and as it ages', () => {
    const thinFresh = noveltyTerm(5, 2);
    const thinOld = noveltyTerm(200, 2);
    const thickFresh = noveltyTerm(5, 40);

    expect(thinFresh).toBeGreaterThan(thinOld);
    expect(thinFresh).toBeGreaterThan(thickFresh);
    expect(noveltyTerm(0, 0)).toBe(0);
  });
});

describe('negative evidence', () => {
  it('a checkin_no tempers an interest without erasing it', () => {
    const positives = spreadEvents('food', 'tandem_completed', 3, 10, 'p');
    const withNo = [
      ...positives,
      makeEvent({ metric: 'food', source: 'checkin_no', polarity: -1, createdAt: T0 }),
    ];

    const before = computeInterestState(positives, T0).metrics['food']!.interest;
    const after = computeInterestState(withNo, T0).metrics['food']!.interest;

    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });
});

describe('expand events', () => {
  it('are recorded but contribute nothing in v1.5', () => {
    const state = computeInterestState(
      [
        makeEvent({ metric: 'games', source: 'expand' }),
        makeEvent({ metric: 'games', source: 'expand' }),
      ],
      T0,
    );
    // Not merely zero-weighted — absent, so they cannot inflate eventCount and
    // suppress the novelty bonus for a signal the model is not using.
    expect(state.metrics['games']).toBeUndefined();
  });
});

describe('provenance', () => {
  it('retains the top contributing events per metric', () => {
    const events = [
      makeEvent({ metric: 'coffee', source: 'tandem_completed', createdAt: T0 }),
      makeEvent({ metric: 'coffee', source: 'join_requested', createdAt: T0 - 40 * DAY }),
      makeEvent({ metric: 'coffee', source: 'checkin_yes', createdAt: T0 }),
    ];
    const state = computeInterestState(events, T0);
    const top = state.metrics['coffee']!.topContributors;

    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThanOrEqual(CONSTANTS.interest.topContributorsPerMetric);
    // checkin_yes is the heaviest source and undecayed, so it must lead.
    expect(top[0]!.source).toBe('checkin_yes');
    // Sorted by absolute contribution, descending.
    for (let i = 1; i < top.length; i++) {
      expect(Math.abs(top[i]!.contribution))
        .toBeLessThanOrEqual(Math.abs(top[i - 1]!.contribution));
    }
  });
});

describe('cache', () => {
  it('a cached state and a rebuild from the log agree exactly', () => {
    const events = [
      ...spreadEvents('coffee', 'tandem_completed', 6, 45, 'c'),
      ...spreadEvents('fitness', 'join_requested', 3, 12, 'f'),
      makeEvent({ metric: 'hiking', source: 'explicit_statement', createdAt: T0 - 3 * DAY }),
    ];

    // "Cached" = what would have been written to user_interest_state.
    const cached = computeInterestState(events, T0, 'viewer');
    // "Rebuilt" = user_interest_state truncated, recomputed from the log alone.
    const rebuilt = rebuildInterestStateFromEvents(events, T0, 'viewer');

    expect(rebuilt).toEqual(cached);
    expect(rebuilt.eventsHash).toBe(cached.eventsHash);
  });

  it('the fingerprint is order-independent but count-sensitive', () => {
    const events = spreadEvents('coffee', 'tandem_completed', 5, 20, 'c');
    const shuffled = [events[3]!, events[0]!, events[4]!, events[1]!, events[2]!];

    expect(computeInterestState(shuffled, T0).eventsHash)
      .toBe(computeInterestState(events, T0).eventsHash);
    expect(computeInterestState(events.slice(0, 4), T0).eventsHash)
      .not.toBe(computeInterestState(events, T0).eventsHash);
  });

  it('a cache is stale when events change, when it ages out, or on version bump', () => {
    const events = spreadEvents('coffee', 'tandem_completed', 3, 10, 'c');
    const ids = events.map((e) => e.id);
    const state = computeInterestState(events, T0, 'viewer');

    expect(isCacheFresh(state, ids, T0)).toBe(true);
    expect(isCacheFresh(state, [...ids, 'new'], T0)).toBe(false);
    expect(isCacheFresh(null, ids, T0)).toBe(false);

    // Decay is time-dependent, so wall-clock alone can stale a cache.
    const past = CONSTANTS.interest.cacheMaxAgeMinutes * 60_000 + 1;
    expect(isCacheFresh(state, ids, T0 + past)).toBe(false);

    expect(isCacheFresh({ ...state, version: 999 }, ids, T0)).toBe(false);
  });
});

describe('explicit statements', () => {
  it('carry weight 1.0 and outrank a lone behavioural event', () => {
    const state = computeInterestState(
      [
        makeEvent({ metric: 'art', source: 'explicit_statement', createdAt: T0 }),
        makeEvent({ metric: 'games', source: 'join_requested', createdAt: T0 }),
      ],
      T0,
    );
    expect(state.metrics['art']!.interest)
      .toBeGreaterThan(state.metrics['games']!.interest);
  });

  it('a negative statement produces zero interest, not a negative one', () => {
    const state = computeInterestState(
      [makeEvent({
        metric: 'concerts', source: 'explicit_statement',
        polarity: -1, createdAt: T0,
      })],
      T0,
    );
    expect(state.metrics['concerts']!.interest).toBe(0);
    expect(state.metrics['concerts']!.rawNegative).toBeGreaterThan(0);
  });
});
