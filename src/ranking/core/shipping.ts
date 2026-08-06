/**
 * The ship gate — v1.7 §3.3.
 *
 * ONE FLAG. Everything user-visible that this repo has built beyond "nearest
 * first, plus demand balancing, minus what you have already been shown this
 * session" is off behind `RANKER_ENABLED`, and `RANKER_ENABLED` is false.
 *
 * The ranker is SHELVED, NOT DELETED. Every module stays in the repo, stays
 * tested, and keeps computing on every deck — its full feature set is written to
 * `ranking_events.score_snapshot` on every impression. It simply does not order
 * anything. That is the whole point: you cannot learn whether the ranker was
 * right without the data, and you cannot get the data by shipping the ranker.
 *
 * ---------------------------------------------------------------------------
 * Why this is a PARAMETER OVERRIDE and not an `if`
 *
 * The obvious implementation is a branch at the top of rank():
 *
 *     if (!RANKER_ENABLED) return proximityDeck(input)
 *
 * That is a second code path. It rots — the shipped path gets the bug fixes and
 * the shelved path quietly stops working, so the day someone flips the flag they
 * find out the ranker has been broken for four months. It is also exactly the
 * mode switch that v1.6 §1 spent an entire architecture avoiding, reintroduced
 * one level up.
 *
 * So the gate is a transformation of the resolved parameters instead. There is
 * still one pipeline, one set of modules, one order of operations. Shelving the
 * ranker means P_join collapses to a proximity delta, the retrieval quotas
 * collapse to proximity, explore goes to zero and the funnel factors go to their
 * identity — all of which are values the existing code already handles, because
 * they are the same values village scale already produces at the extremes.
 *
 * The shelved path is therefore not a path. It is the live path with different
 * numbers, which is the only kind of dormant code that still works when you
 * wake it up.
 */

import { CONSTANTS } from './constants.js';
import type { ResolvedParams, RetrievalSource } from './types.js';

/**
 * THE flag. Everything user-visible in this repo hangs off it.
 *
 * False for the beta. App Store review is in progress; logging and migrations
 * are invisible and may ship on, but nothing that changes what a person sees
 * goes out until there is data saying it should.
 *
 * Read in exactly one place (rank.ts), enforced by tests/purity.test.ts.
 */
export const RANKER_ENABLED = false;

/**
 * Collapse the resolved parameters to the shipping configuration.
 *
 * Deck order becomes:
 *
 *     S = proximity x demand x sessionPenalties
 *
 * and nothing else. Specifically:
 *
 *   pJoin           a delta on proximity. Interest weights, intent, timeFit,
 *                   socialContext and graph all go to zero — they still get
 *                   COMPUTED and LOGGED, they just stop deciding anything.
 *   quotas          all mass to proximity. No affinity retrieval, no explore
 *                   draw, no reserved fresh-host slot.
 *   exploreEpsilon  zero. The epsilon swap is the one thing here that would be
 *                   visible to a user as unexplained randomness.
 *   funnelExponent  zero, so P_accept and R_repeat raise to the identity.
 *                   v1.6 §G3 measured these displacing nearer cards at every
 *                   density; until something says they pay for themselves, they
 *                   do not get to.
 *   completionFloor zero, so the v1.8 §1.3 completion gate does not order
 *                   anything to the tail.
 *
 * What is NOT switched off, and why:
 *
 *   demandWeight, overflowPenalty  §3.3 names demand balancing as shipping.
 *   noveltyBoost                   the interest vector is still computed for
 *                                  the snapshot, so the logged value must be
 *                                  the real one, not a neutered one.
 *   the impression floor           it is a host-retention rule, and host
 *                                  retention is now the primary metric. Judged
 *                                  in rather than out; see DIAGNOSTICS.md.
 *   session penalties              they ARE the shipping behaviour.
 */
export function applyShipGate(params: ResolvedParams): ResolvedParams {
  if (RANKER_ENABLED) return params;

  const quotas = {} as Record<RetrievalSource, number>;
  for (const source of Object.keys(params.quotas) as RetrievalSource[]) {
    quotas[source] = source === 'proximity' ? 1 : 0;
  }

  return {
    ...params,
    pJoin: {
      interestAffinity: 0,
      proximity: 1,
      timeFit: 0,
      intentMatch: 0,
      socialContext: 0,
      graphAffinity: 0,
    },
    quotas,
    exploreEpsilon: 0,
    funnelExponent: CONSTANTS.shipping.shelvedFunnelExponent,
    // The completion gate is ranker machinery too. §3.3's shipping order is
    // proximity x demand x session penalties and nothing else.
    completionFloor: 0,
  };
}
