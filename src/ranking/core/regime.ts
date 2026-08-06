/**
 * Density adaptation — v1.6 §1.
 *
 * ONE ALGORITHM. There is no mode switch, no second code path, no boolean flag.
 * Every scale-dependent parameter is declared as a { village, city } pair and
 * resolved to a plain number by interpolating on a continuous scalar. Village
 * behaviour is the mathematical limit of city behaviour as regime -> 0.
 *
 * That is not aesthetics. A switch at a user-count threshold produces a visible
 * discontinuity in product feel on a single day, is untestable in exactly the
 * region that matters, and gets flipped the wrong way at least once.
 *
 * The boundary this module draws is strict: resolveParams() is the last place
 * the regime scalar exists. score.ts, slate.ts, retrieval.ts and explain.ts
 * receive resolved numbers and have no idea density is a concept. That
 * separation is enforced by tests/purity.test.ts, which fails the build if any
 * of them import this file.
 */

import { CONSTANTS } from './constants.js';
import type { Epoch, ResolvedParams, RetrievalSource, Scaled, Unit } from './types.js';

export type { ResolvedParams, Scaled } from './types.js';

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/**
 * Linear interpolation on the regime scalar. `regime` is clamped, so an
 * out-of-range value degrades to the nearer endpoint rather than extrapolating
 * into nonsense.
 */
export function resolve(p: Scaled<number>, regime: number): number {
  const t = clamp01(regime);
  // Exact at the endpoints. `a + (b - a) * 1` is not reliably `b` in floating
  // point (0.5 + (0.1 - 0.5) * 1 = 0.09999999999999998), and a parameter that
  // is almost-but-not-quite its declared value is the kind of thing that makes
  // someone doubt the whole table.
  if (t === 0) return p.village;
  if (t === 1) return p.city;
  return p.village + (p.city - p.village) * t;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * What a client must measure to place a user on the continuum.
 *
 * Deliberately NOT user count. User count stops being a proxy the moment users
 * are non-uniformly distributed: a dense urban cluster hits city conditions at
 * 200 total users while a rural user is still enumerating their whole pool at
 * 2,000. Two users of the same app can sit in different regimes on the same
 * day, and that is correct.
 */
export interface CoverageObservation {
  /**
   * Posts in the last 7 days passing this user's default radius and time pills,
   * excluding blocked users and their own posts.
   */
  eligiblePostsPerWeek: number;
  /**
   * Impressions per week from `ranking_events`. Null when there is not enough
   * history to measure it.
   */
  cardsViewedPerWeek: number | null;
  /** Weeks of impression history available. Below the threshold we use a default. */
  weeksOfHistory: number;
}

/** Persisted between sessions so smoothing and hysteresis have something to smooth. */
export interface RegimeState {
  coverageEwma: number | null;
  /** The last regime scalar actually emitted, for the hysteresis band. */
  lastRegime: number | null;
  updatedAt: Epoch | null;
}

export interface RegimeReading {
  /** This week's raw coverage. Noisy; not used directly for anything. */
  coverage: number;
  /** The smoothed value the regime is derived from. */
  coverageEwma: number;
  /** The regime scalar actually in force, after hysteresis. 0 village, 1 city. */
  regime: number;
  /** What the smoothed coverage implies, before hysteresis. */
  regimeUnsmoothed: number;
  /** True when hysteresis suppressed a move. Useful when debugging stickiness. */
  held: boolean;
}

/**
 * coverage = eligiblePostsPerWeek / cardsViewedPerWeek.
 *
 * Below 1, the user cannot see everything even if they try. Above ~4, most of
 * the pool never gets looked at and selection is doing real work.
 */
export function coverageOf(obs: CoverageObservation): number {
  const viewed =
    obs.cardsViewedPerWeek !== null &&
    obs.weeksOfHistory >= CONSTANTS.regime.minWeeksOfHistory &&
    obs.cardsViewedPerWeek > 0
      ? obs.cardsViewedPerWeek
      : CONSTANTS.regime.defaultCardsViewedPerWeek;

  return Math.max(0, obs.eligiblePostsPerWeek) / viewed;
}

/** 4-week EWMA. A null prior seeds from the first observation rather than from 0. */
export function updateCoverageEwma(previous: number | null, raw: number): number {
  if (previous === null || !Number.isFinite(previous)) return raw;
  const a = CONSTANTS.regime.coverageEwmaAlpha;
  return a * raw + (1 - a) * previous;
}

/** Map smoothed coverage onto [0, 1]. */
export function regimeFromCoverage(coverageEwma: number): Unit {
  const { coverageLow, coverageHigh } = CONSTANTS.regime;
  return clamp01((coverageEwma - coverageLow) / (coverageHigh - coverageLow));
}

/**
 * Hysteresis. The regime only moves if the newly-implied value differs from the
 * last emitted one by more than the band.
 *
 * Without this, raw weekly coverage flips the regime week to week and the user
 * experiences the deck inexplicably changing character — the deck gets more
 * exploratory, then less, then more, for no reason they can perceive. The band
 * costs some responsiveness at the edges, which is the correct trade.
 *
 * Note the band applies to the REGIME SCALAR, not to coverage. The spec's
 * phrasing ("crosses the current regime value") is ambiguous between the two;
 * the scalar is the one with a meaningful fixed scale, since coverage is
 * unbounded above. Flagged in INFERENCES.md.
 */
export function applyHysteresis(candidate: Unit, last: number | null): Unit {
  if (last === null || !Number.isFinite(last)) return candidate;
  if (Math.abs(candidate - last) > CONSTANTS.regime.hysteresisBand) return candidate;
  return clamp01(last);
}

/**
 * Note on the dead zone: because a move is only accepted when it exceeds the
 * band, the emitted regime can sit up to `hysteresisBand` away from the value
 * the smoothed coverage actually implies, indefinitely. That is inherent to
 * hysteresis rather than a defect — it is the price of not flip-flopping — and
 * it is bounded, which is what matters. Accepted moves snap to the candidate
 * rather than stepping by the band, so the error never accumulates.
 */

/** The whole pipeline: observation + stored state -> the regime in force. */
export function computeRegime(
  obs: CoverageObservation,
  state: RegimeState | null,
): RegimeReading {
  const coverage = coverageOf(obs);
  const coverageEwma = updateCoverageEwma(state?.coverageEwma ?? null, coverage);
  const regimeUnsmoothed = regimeFromCoverage(coverageEwma);
  const regime = applyHysteresis(regimeUnsmoothed, state?.lastRegime ?? null);

  return {
    coverage,
    coverageEwma,
    regime,
    regimeUnsmoothed,
    held: regime !== regimeUnsmoothed,
  };
}

// ---------------------------------------------------------------------------
// Resolved parameters
// ---------------------------------------------------------------------------

/**
 * Resolve the parameters for one session.
 *
 * AS OF v1.8 §2 THIS IS AN IDENTITY. Every parameter it returns is a single
 * constant; `regime` is accepted, validated and ignored.
 *
 * The signature is unchanged on purpose. Reactivating density adaptation means
 * turning one of `CONSTANTS.collapsed.*` back into a `{ village, city }` pair
 * and putting `resolve(pair, t)` back on that line — one edit per parameter,
 * with every caller, every test and the whole interpolation machinery still in
 * place. See `CONSTANTS.collapsed` for why the pairs were collapsed and what
 * would justify bringing one back.
 *
 * P_join weights are still renormalised, which keeps the declared table
 * readable as relative importances rather than as pre-divided fractions.
 */
export function resolveParams(regime: number): ResolvedParams {
  // Clamped for the contract rather than for the arithmetic: callers still pass
  // a regime, `getRegimeDebug` still reports one, and a NaN leaking through
  // here would be a silent contract violation even while nothing reads it.
  clamp01(regime);

  const c = CONSTANTS.collapsed;

  const joinSum =
    c.pJoin.interestAffinity + c.pJoin.proximity + c.pJoin.timeFit +
    c.pJoin.intentMatch + c.pJoin.socialContext + c.pJoin.graphAffinity;

  // Guaranteed non-zero by the load-time assertion in constants.ts, but a
  // division that can silently produce NaN in a ranking path is worth a guard.
  if (!(joinSum > 0)) {
    throw new Error(`resolveParams: P_join weights sum to ${joinSum}`);
  }

  const pJoin = {
    interestAffinity: c.pJoin.interestAffinity / joinSum,
    proximity: c.pJoin.proximity / joinSum,
    timeFit: c.pJoin.timeFit / joinSum,
    intentMatch: c.pJoin.intentMatch / joinSum,
    socialContext: c.pJoin.socialContext / joinSum,
    graphAffinity: c.pJoin.graphAffinity / joinSum,
  };

  const quotas: Record<RetrievalSource, number> = {
    affinity: c.quotas.affinity,
    proximity: c.quotas.proximity,
    fresh_host: c.quotas.fresh_host,
    random: c.quotas.random,
    graph: c.quotas.graph,
  };

  return {
    pJoin,
    quotas,
    exploreEpsilon: c.exploreEpsilon,
    categoryPenalty: c.categoryPenalty,
    hostPenalty: c.hostPenalty,
    demandWeight: c.demandWeight,
    overflowPenalty: c.overflowPenalty,
    exhaustionRate: c.exhaustionRate,
    noveltyBoost: c.noveltyBoost,
    funnelExponent: CONSTANTS.shipping.funnelExponent,
    completionFloor: CONSTANTS.score.completionFloor,
    repeatableContextWeight: CONSTANTS.score.rRepeat.repeatableContext,
    repeatableContextDamping: CONSTANTS.score.repeatableContextDamping,
  };
}

/**
 * A stable fingerprint of the resolved parameters.
 *
 * The interest vector depends on `noveltyBoost`. That parameter moved with
 * density through v1.7, so a vector computed under one regime was WRONG under
 * another rather than merely stale — hence this fingerprint (INFERENCES §F6).
 *
 * v1.8 §2 collapsed the pairs, so `noveltyBoost` is now constant and the
 * fingerprint is constant with it. The mechanism is retained rather than
 * removed: it costs one string per cache write, and it is exactly what would be
 * needed again the day a swept pair earns reactivation. A cache-invalidation
 * bug found six months after the fact is not worth the deletion.
 */
export function paramsFingerprint(params: ResolvedParams): string {
  return `nb:${params.noveltyBoost.toFixed(4)}`;
}

function clamp01(x: number): Unit {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
