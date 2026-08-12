/**
 * The completion gate — v1.8 §1.3.
 *
 * `P_complete` answers "will this post actually happen", which is genuinely
 * useful and genuinely global. It is also FILTER-SHAPED, and a filter-shaped
 * question asked as a multiplier compounds identically for every viewer — the
 * §D3 defect precisely.
 *
 * So it became an ordering key. The tests that matter here are the ones proving
 * it is a key and not a filter in disguise: no value of the floor, including 1,
 * may shorten a deck or empty one.
 */

import { describe, expect, it } from 'vitest';
import { rank } from '../src/ranking/core/rank.js';
import { compareScored, scoreCandidates, scoreFeatures } from '../src/ranking/core/score.js';
import { resolveParams } from '../src/ranking/core/regime.js';
import { computeInterestState } from '../src/ranking/core/interest.js';
import { CONSTANTS } from '../src/ranking/core/constants.js';
import {
  T0,
  makeCandidate,
  makeHost,
  makeViewer,
  standardPool,
} from './fixtures/index.js';
import type { Candidate, FeatureVector, ScoredCandidate } from '../src/ranking/core/types.js';

const EMPTY_STATE = computeInterestState([], T0, 'u1');
const RANKER = resolveParams(1);

/** A host with an explicit completion record. */
function post(id: string, completed: number, hosted: number, distanceMiles = 1): Candidate {
  return makeCandidate({
    activityId: id,
    hostId: `h_${id}`,
    distanceMiles,
    host: makeHost({
      hostId: `h_${id}`,
      completedCount: completed,
      hostedCount: hosted,
    }),
  });
}

describe('P_complete no longer multiplies', () => {
  it('two cards differing only in completion history score identically', () => {
    // The whole point. Before v1.8 the reliable host's card scored strictly
    // higher for EVERY viewer, which is how consensus formed.
    const reliable = post('a', 20, 20);
    const flaky = post('b', 1, 20);
    const viewer = makeViewer();

    const scored = scoreCandidates(viewer, [reliable, flaky], EMPTY_STATE, T0, RANKER);
    const byId = new Map(scored.map((s) => [s.candidate.activityId, s]));

    expect(byId.get('a')!.funnel.pComplete)
      .toBeGreaterThan(byId.get('b')!.funnel.pComplete);
    // ...and yet the scores are equal, because P_complete is not a factor.
    expect(byId.get('a')!.funnel.score).toBeCloseTo(byId.get('b')!.funnel.score, 12);
  });

  it('still computes and reports P_complete for the impression snapshot', () => {
    // Removed from the product, not from the record. The question "would
    // P_complete have ranked this better" has to stay answerable offline.
    const scored = scoreCandidates(
      makeViewer(), [post('a', 20, 20)], EMPTY_STATE, T0, RANKER,
    );
    expect(scored[0]!.funnel.pComplete).toBeGreaterThan(0);
    expect(typeof scored[0]!.funnel.belowCompletionFloor).toBe('boolean');
  });
});

describe('the gate orders, it does not filter', () => {
  it('sorts below-floor cards to the tail regardless of their score', () => {
    // The flaky host is the NEAREST card, so on score alone it would lead.
    const flakyNear = post('near_flaky', 0, 40, 0.1);
    const solidFar = post('far_solid', 40, 40, 8);

    const gated = { ...RANKER, completionFloor: 0.5 };
    const scored = scoreCandidates(
      makeViewer(), [flakyNear, solidFar], EMPTY_STATE, T0, gated,
    );

    expect(scored[0]!.candidate.activityId).toBe('far_solid');
    expect(scored[1]!.candidate.activityId).toBe('near_flaky');
    expect(scored[1]!.funnel.belowCompletionFloor).toBe(true);
    // Still reachable. Last is not gone.
    expect(scored).toHaveLength(2);
  });

  it('NO floor value can shorten or empty a deck — including 1.0', () => {
    // The framework's absolute rule. A floor of 1 puts every card below the
    // gate; the deck must come out exactly as long as it would have been.
    const pool = standardPool();

    for (const floor of [0, 0.25, 0.5, 0.9, 1, 2]) {
      const result = rank(
        {
          viewer: makeViewer(),
          candidates: pool,
          interestEvents: [],
          sessionId: 'sess',
          now: T0,
          regime: 1,
        },
        { paramsOverride: { ...RANKER, completionFloor: floor } },
      );

      expect(
        result.slate.cards.length,
        `completionFloor ${floor} changed the deck length`,
      ).toBe(Math.min(pool.length, CONSTANTS.slate.deckSize));
      expect(result.slate.degraded).toBe(false);
    }
  });

  it('orders within the below-floor block rather than lumping it', () => {
    // Two flaky hosts still get ranked against each other. "Last" is a block,
    // not a bucket everything falls into unordered.
    const gated = { ...RANKER, completionFloor: 1 };
    const scored = scoreCandidates(
      makeViewer(),
      [post('far', 0, 40, 9), post('near', 0, 40, 0.2)],
      EMPTY_STATE, T0, gated,
    );

    expect(scored.every((s) => s.funnel.belowCompletionFloor)).toBe(true);
    expect(scored[0]!.candidate.activityId).toBe('near');
  });

  it('a floor of zero gates nothing at all', () => {
    // Strictly-below, so the ship gate's `completionFloor: 0` is a true no-op
    // rather than "gates only the pathological case".
    const scored = scoreCandidates(
      makeViewer(), [post('a', 0, 100)], EMPTY_STATE, T0,
      { ...RANKER, completionFloor: 0 },
    );
    expect(scored[0]!.funnel.belowCompletionFloor).toBe(false);
  });
});

describe('the gate survives slate assembly', () => {
  it('the session-penalty argmax cannot promote a gated card over an ungated one', () => {
    // The subtle failure this guards: slate.ts re-argmaxes on
    // session-adjusted score. Without a lexicographic comparison there, a
    // below-floor card could out-argmax an above-floor one and silently undo
    // the gate applied upstream.
    const pool = [
      // Gated, but nearest and in a category nothing else uses, so its
      // session-adjusted score is the highest in the pool.
      makeCandidate({
        activityId: 'gated_best', hostId: 'hg', category: 'markets',
        distanceMiles: 0.05,
        host: makeHost({ hostId: 'hg', completedCount: 0, hostedCount: 60 }),
      }),
      ...Array.from({ length: 7 }, (_, i) => makeCandidate({
        activityId: `ok${i}`, hostId: `h${i}`, category: 'coffee',
        distanceMiles: 3 + i,
        host: makeHost({ hostId: `h${i}`, completedCount: 30, hostedCount: 30 }),
      })),
    ];

    const result = rank(
      {
        viewer: makeViewer(), candidates: pool, interestEvents: [],
        sessionId: 'sess', now: T0, regime: 1,
      },
      { debug: true, paramsOverride: { ...RANKER, completionFloor: 0.5 } },
    );

    const positions = result.slate.cards.map((c) => c.activityId);
    expect(positions).toContain('gated_best');
    // Present, and last.
    expect(positions[positions.length - 1]).toBe('gated_best');
  });

  it('may push a gated card past a TRUNCATED deck — and that is still not filtering', () => {
    // Worth stating precisely rather than eliding. The gate orders the whole
    // pool; a deck is a fetch window over that order. So a gated card can fall
    // outside the first eight.
    //
    // That is not the deck being filtered. Discover shows one card at a time,
    // the pool does not reset between fetches, and the session-shown counters
    // carry across — so the card is reached on a subsequent fetch. The
    // invariant the framework actually asserts is about the ORDER being total
    // and the deck being FULL, and both hold below.
    const pool = [
      makeCandidate({
        activityId: 'gated', hostId: 'hg', distanceMiles: 0.05,
        host: makeHost({ hostId: 'hg', completedCount: 0, hostedCount: 60 }),
      }),
      ...Array.from({ length: 12 }, (_, i) => makeCandidate({
        activityId: `ok${i}`, hostId: `h${i}`, distanceMiles: 3 + i,
        host: makeHost({ hostId: `h${i}`, completedCount: 30, hostedCount: 30 }),
      })),
    ];

    const result = rank(
      {
        viewer: makeViewer(), candidates: pool, interestEvents: [],
        sessionId: 'sess', now: T0, regime: 1,
      },
      { debug: true, paramsOverride: { ...RANKER, completionFloor: 0.5 } },
    );

    // Deck is full — nothing was dropped for being gated.
    expect(result.slate.cards).toHaveLength(CONSTANTS.slate.deckSize);
    // And the card is present in the ORDER, in last place, where the gate put it.
    const ordered = result.debug!.scored.map((s) => s.candidate.activityId);
    expect(ordered).toHaveLength(pool.length);
    expect(ordered[ordered.length - 1]).toBe('gated');
  });
});

describe('the ship gate disables it', () => {
  it('the shipped configuration gates nothing', () => {
    // A completion floor is ranker machinery, and the shipped order is
    // proximity x demand x session penalties.
    const result = rank(
      {
        viewer: makeViewer(), candidates: [post('a', 0, 100)],
        interestEvents: [], sessionId: 's', now: T0, regime: 1,
      },
      { debug: true },
    );
    expect(result.debug!.params.completionFloor).toBe(0);
    expect(result.snapshots[0]!.computed.funnel.belowCompletionFloor).toBe(false);
  });
});

describe('compareScored', () => {
  const at = (id: string, score: number, gated: boolean): ScoredCandidate => ({
    candidate: makeCandidate({ activityId: id }),
    features: {} as FeatureVector,
    funnel: { score, belowCompletionFloor: gated } as ScoredCandidate['funnel'],
  });

  it('is a total order', () => {
    const items = [
      at('c', 0.9, true), at('a', 0.1, false), at('b', 0.5, false), at('d', 0.1, true),
    ];
    expect([...items].sort(compareScored).map((s) => s.candidate.activityId))
      .toEqual(['b', 'a', 'c', 'd']);
    // Reversing the input cannot change the output, or it is not a total order.
    expect([...items].reverse().sort(compareScored).map((s) => s.candidate.activityId))
      .toEqual(['b', 'a', 'c', 'd']);
  });

  it('breaks exact ties by id so the deck is reproducible', () => {
    const items = [at('z', 0.5, false), at('a', 0.5, false)];
    expect(items.sort(compareScored).map((s) => s.candidate.activityId)).toEqual(['a', 'z']);
  });
});

describe('the funnel exponent no longer touches P_complete', () => {
  it('changing it leaves the gate decision alone', () => {
    const features = { completionPrior: 0.1, freshness: 0.1 } as FeatureVector;
    const params = { ...RANKER, completionFloor: 0.5 };

    for (const funnelExponent of [0, 0.5, 1]) {
      const funnel = scoreFeatures({ ...features } as FeatureVector, {
        ...params, funnelExponent,
      });
      expect(funnel.belowCompletionFloor).toBe(true);
    }
  });
});
