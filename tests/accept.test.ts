/**
 * P_accept, repaired — v1.8 §1.2.
 *
 * The property that matters is not any individual number. It is that the term
 * PRODUCES DIFFERENT ORDERINGS FOR DIFFERENT VIEWERS. That is the whole content
 * of the reclassification from `global_quality` to `pairwise`, and without it
 * the repair would be cosmetic: a viewer's reputation applied uniformly to
 * every card in their deck rescales the deck and reorders nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  acceptLikelihood,
  buildScoringContext,
  categoryFamiliarity,
  graphCloseness,
  hostReliability,
  rankNormalise,
  viewerDeviation,
  viewerExperience,
  viewerFollowThrough,
} from '../src/ranking/core/features.js';
import { CONSTANTS } from '../src/ranking/core/constants.js';
import { makeCandidate, makeHost, makeViewer } from './fixtures/index.js';
import type { Candidate, Viewer } from '../src/ranking/core/types.js';

const NEUTRAL = CONSTANTS.features.thinDataDefault;

/** A host with an explicit accept record. */
function host(id: string, accepts: number, requests: number, category = 'coffee'): Candidate {
  return makeCandidate({
    activityId: `a_${id}`,
    hostId: id,
    category,
    host: makeHost({ hostId: id, acceptCount: accepts, requestCount: requests }),
  });
}

describe('rank normalisation', () => {
  it('maps a spread of values into (0, 1]', () => {
    const ranked = rankNormalise(new Map([['a', 0.1], ['b', 0.5], ['c', 0.9]]));
    expect(ranked.get('a')).toBeCloseTo(1 / 3, 12);
    expect(ranked.get('b')).toBeCloseTo(2 / 3, 12);
    expect(ranked.get('c')).toBe(1);
  });

  it('gives tied values the same rank rather than inventing an order', () => {
    // Twenty hosts with identical records must not be silently ordered by id.
    const ranked = rankNormalise(new Map([['a', 0.5], ['b', 0.5], ['c', 0.5], ['d', 0.9]]));
    expect(ranked.get('a')).toBe(ranked.get('b'));
    expect(ranked.get('b')).toBe(ranked.get('c'));
    expect(ranked.get('d')).toBe(1);
  });

  it('is scale-invariant, which a raw rate is not', () => {
    // The point of ranking. An 0.8 accept rate is unremarkable among 0.9s and
    // exceptional among 0.4s; the raw number cannot tell the difference.
    const tight = rankNormalise(new Map([['a', 0.88], ['b', 0.90], ['c', 0.92]]));
    const wide = rankNormalise(new Map([['a', 0.10], ['b', 0.50], ['c', 0.95]]));
    expect([...tight.values()].sort()).toEqual([...wide.values()].sort());
  });

  it('handles an empty and a single-element population', () => {
    expect(rankNormalise(new Map()).size).toBe(0);
    expect(rankNormalise(new Map([['only', 0.3]])).get('only')).toBe(1);
  });
});

describe('the viewer-side sub-features are neutral on no data', () => {
  it('a brand-new viewer deviates by exactly zero', () => {
    // The cold-start property. A weighted MEAN would hand a new viewer 0.5 and
    // halve their P_accept against an experienced one — the deck punishing you
    // for not having used the app yet. A deviation from neutral cannot do that.
    const fresh: Viewer = { ...makeViewer(), verified: false };
    delete (fresh as { completedTandems?: number }).completedTandems;
    delete (fresh as { acceptedRequests?: number }).acceptedRequests;
    delete (fresh as { postedCategories?: string[] }).postedCategories;

    expect(viewerDeviation(fresh, host('h', 5, 10))).toBe(0);
  });

  it('experience saturates and starts at zero, not at a penalty', () => {
    const at = (n: number) => viewerExperience({ ...makeViewer(), completedTandems: n });
    expect(at(0)).toBe(0);
    expect(at(1)).toBeGreaterThan(0);
    expect(at(3)).toBeCloseTo(0.5, 12);
    expect(at(40) - at(30)).toBeLessThan(at(4) - at(3));
    expect(at(1000)).toBeLessThan(1);
  });

  it('follow-through sits at neutral until there is something to follow through on', () => {
    expect(viewerFollowThrough(makeViewer())).toBe(NEUTRAL);
    expect(viewerFollowThrough({ ...makeViewer(), acceptedRequests: 0, noShows: 0 }))
      .toBe(NEUTRAL);

    const reliable = viewerFollowThrough({
      ...makeViewer(), acceptedRequests: 10, noShows: 0,
    });
    const flaky = viewerFollowThrough({
      ...makeViewer(), acceptedRequests: 10, noShows: 8,
    });
    expect(reliable).toBeGreaterThan(NEUTRAL);
    expect(flaky).toBeLessThan(NEUTRAL);
  });

  it('category familiarity is neutral with no posting history, not zero', () => {
    // "Has never hosted" is not "hosts the wrong things".
    expect(categoryFamiliarity(makeViewer(), host('h', 5, 10))).toBe(NEUTRAL);

    const poster = { ...makeViewer(), postedCategories: ['coffee', 'hiking'] };
    expect(categoryFamiliarity(poster, host('h', 5, 10, 'coffee'))).toBe(1);
    expect(categoryFamiliarity(poster, host('h', 5, 10, 'concerts'))).toBe(0);
  });

  it('the graph stub contributes exactly zero deviation despite a real weight', () => {
    // Contrast with INFERENCES §F2, where an inert feature could NOT be given a
    // real weight: P_join renormalises, so a zero-valued term there survives
    // renormalisation and depresses everyone. This form sums deviations from
    // neutral, so an inert term adds 0. Same stub, opposite consequence.
    expect(graphCloseness(makeViewer(), host('h', 5, 10))).toBe(NEUTRAL);
    expect(CONSTANTS.features.acceptance.weights.graphCloseness).toBeGreaterThan(0);

    const fresh: Viewer = { ...makeViewer(), verified: false };
    delete (fresh as { completedTandems?: number }).completedTandems;
    delete (fresh as { acceptedRequests?: number }).acceptedRequests;
    delete (fresh as { postedCategories?: string[] }).postedCategories;
    expect(viewerDeviation(fresh, host('h', 5, 10))).toBe(0);
  });
});

describe('pickiness is what earns the pairwise reclassification', () => {
  const pool = [
    host('picky', 1, 20),        // accepts almost nobody
    host('open', 19, 20),        // accepts almost everyone
  ];
  const context = buildScoringContext(pool);
  const rankOf = (id: string) => context.hostReliabilityRank.get(id) as number;

  const good: Viewer = {
    ...makeViewer(), verified: true, completedTandems: 20,
    acceptedRequests: 20, noShows: 0,
  };
  const bad: Viewer = {
    ...makeViewer(), verified: false, completedTandems: 0,
    acceptedRequests: 10, noShows: 9,
  };

  it('a selective host discriminates between requesters; an open one barely does', () => {
    const pickyGap =
      acceptLikelihood(good, pool[0] as Candidate, rankOf('picky')) -
      acceptLikelihood(bad, pool[0] as Candidate, rankOf('picky'));
    const openGap =
      acceptLikelihood(good, pool[1] as Candidate, rankOf('open')) -
      acceptLikelihood(bad, pool[1] as Candidate, rankOf('open'));

    expect(pickyGap).toBeGreaterThan(0);
    expect(pickyGap).toBeGreaterThan(openGap);
  });

  it('WITHOUT pickiness the viewer term would reorder nothing', () => {
    // The load-bearing test for the whole repair.
    //
    // A viewer's reputation is the same number for every card in their deck. If
    // it entered as a bare factor, P_accept would be (viewer constant) x
    // hostRank^rho — a uniform rescale, leaving the ordering exactly hostRank^rho.
    // That is the same global consensus at lower volume, which is not a repair.
    //
    // Here the simulated "no pickiness" version is exactly that, and it does not
    // reorder. The real one does.
    const flat = (v: Viewer, c: Candidate, rank: number) =>
      Math.pow(rank, CONSTANTS.features.acceptance.hostAcceptDamping) *
      (1 + viewerDeviation(v, c));

    const flatOrder = [...pool]
      .sort((a, b) => flat(bad, b, rankOf(b.hostId)) - flat(bad, a, rankOf(a.hostId)))
      .map((c) => c.hostId);
    const flatOrderGood = [...pool]
      .sort((a, b) => flat(good, b, rankOf(b.hostId)) - flat(good, a, rankOf(a.hostId)))
      .map((c) => c.hostId);

    // Uniform rescale: both viewers get the same order. No consensus broken.
    expect(flatOrderGood).toEqual(flatOrder);

    // With pickiness, the good and bad viewers see different RATIOS between the
    // two hosts — the term now carries information about the pair.
    const ratio = (v: Viewer) =>
      acceptLikelihood(v, pool[0] as Candidate, rankOf('picky')) /
      acceptLikelihood(v, pool[1] as Candidate, rankOf('open'));
    expect(ratio(good)).not.toBeCloseTo(ratio(bad), 6);
  });

  it('a category-matching viewer is preferred by a selective host specifically', () => {
    // categoryFamiliarity is the sub-feature that varies card to card, so it is
    // the one that can move a deck's order rather than its level.
    const coffeePoster = { ...makeViewer(), postedCategories: ['coffee'] };
    const coffee = host('picky', 1, 20, 'coffee');
    const concert = host('picky', 1, 20, 'concerts');
    const rank = rankOf('picky');

    expect(acceptLikelihood(coffeePoster, coffee, rank))
      .toBeGreaterThan(acceptLikelihood(coffeePoster, concert, rank));
  });
});

describe('the damping exponent', () => {
  it('compresses the spread between the best and worst host', () => {
    const rho = CONSTANTS.features.acceptance.hostAcceptDamping;
    expect(rho).toBeGreaterThan(0);
    expect(rho).toBeLessThanOrEqual(1);

    // With a neutral viewer, P_accept is exactly hostRank^rho, so the ratio
    // between the extremes is compressed by exactly the exponent.
    const neutralViewer: Viewer = { ...makeViewer(), verified: false };
    delete (neutralViewer as { completedTandems?: number }).completedTandems;
    delete (neutralViewer as { acceptedRequests?: number }).acceptedRequests;
    delete (neutralViewer as { postedCategories?: string[] }).postedCategories;

    const worst = acceptLikelihood(neutralViewer, host('w', 0, 20), 0.1);
    const best = acceptLikelihood(neutralViewer, host('b', 20, 20), 1.0);
    expect(best / worst).toBeLessThan(1 / 0.1);      // less than the raw ratio
    expect(best / worst).toBeGreaterThan(1);          // but still an advantage
  });

  it('falls back to the raw rate when no population context is supplied', () => {
    // A unit test scoring one card has no population. Degrading to v1.7
    // behaviour is correct there and wrong for a deck — scoreCandidates always
    // supplies the context.
    const c = host('h', 10, 20);
    expect(acceptLikelihood(makeViewer(), c)).toBeGreaterThan(0);
    expect(Number.isFinite(acceptLikelihood(makeViewer(), c))).toBe(true);
  });
});

describe('invariants', () => {
  it('stays in [0, 1] under every combination', () => {
    const viewers: Viewer[] = [
      makeViewer(),
      { ...makeViewer(), verified: true, completedTandems: 500, acceptedRequests: 500, noShows: 0 },
      { ...makeViewer(), verified: false, acceptedRequests: 100, noShows: 100 },
    ];
    for (const v of viewers) {
      for (const rank of [0, 0.01, 0.5, 1]) {
        const p = acceptLikelihood(v, host('h', 3, 9), rank);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  it('auto-accept for a trusted viewer is still a certainty', () => {
    const c = makeCandidate({
      activityId: 'a1', hostId: 'h1', autoAcceptTrusted: true,
      host: makeHost({ hostId: 'h1', acceptCount: 0, requestCount: 50 }),
    });
    const trusted = { ...makeViewer(), trustedByHostIds: ['h1'] };
    expect(acceptLikelihood(trusted, c, 0.01)).toBe(1);
  });

  it('never lets a bad record drive P_accept to zero', () => {
    // The score orders and never filters. A requester with a poor history is
    // ranked lower, not excluded — and the deviation floor is what guarantees it.
    const worst: Viewer = {
      ...makeViewer(), verified: false, acceptedRequests: 50, noShows: 50,
      postedCategories: ['nothing_like_this'],
    };
    expect(viewerDeviation(worst, host('h', 1, 20)))
      .toBeGreaterThanOrEqual(CONSTANTS.features.acceptance.deviationFloor);
    expect(acceptLikelihood(worst, host('h', 1, 20), 0.5)).toBeGreaterThan(0);
  });

  it('the host term still ranks hosts, just less steeply', () => {
    const neutralViewer = makeViewer();
    const low = acceptLikelihood(neutralViewer, host('l', 1, 20), 0.2);
    const high = acceptLikelihood(neutralViewer, host('h', 19, 20), 0.9);
    expect(high).toBeGreaterThan(low);
  });
});

describe('buildScoringContext', () => {
  it('ranks each host once, not once per post', () => {
    const pool = [
      host('a', 1, 10), host('a', 1, 10), host('b', 9, 10),
    ];
    const context = buildScoringContext(pool);
    expect(context.hostReliabilityRank.size).toBe(2);
    expect(context.hostReliabilityRank.get('b')).toBe(1);
  });

  it('ranks categories for the repeatableContext term too', () => {
    const pool = [host('a', 1, 10, 'coffee'), host('b', 1, 10, 'concerts')];
    const context = buildScoringContext(pool);
    // coffee is routine (1.0), concerts one_off (0.25) — so coffee ranks top.
    expect(context.repeatableContextRank.get('coffee')).toBe(1);
    expect(context.repeatableContextRank.get('concerts')).toBeLessThan(1);
  });

  it('is empty for an empty pool rather than throwing', () => {
    const context = buildScoringContext([]);
    expect(context.hostReliabilityRank.size).toBe(0);
    expect(hostReliability(host('a', 1, 10))).toBeGreaterThan(0);
  });
});
