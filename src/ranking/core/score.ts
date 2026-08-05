/**
 * The decomposed funnel — framework §4.
 *
 *   S = P_join x P_accept x P_complete x R_repeat
 *
 * Four factors instead of one number, because each is separately learnable in
 * v2: export ranking_events, fit one logistic regression per stage, paste the
 * coefficients back into CONSTANTS.score. The architecture does not change; the
 * numbers get better.
 *
 * The score ORDERS the deck. It never filters it. Time pills filter; the score
 * sorts what survives. An empty deck is a bug.
 */

import { CONSTANTS } from './constants.js';
import { computeFeatures } from './features.js';
import { NEUTRAL_DEMAND, demandAdjustment, type DemandAdjustment } from './demand.js';
import { TERM_CLASS, type TermName } from './classification.js';
import type {
  Candidate,
  Epoch,
  FeatureVector,
  FunnelScore,
  InterestState,
  ResolvedParams,
  ScoredCandidate,
  Viewer,
} from './types.js';

/**
 * THE LEAF TERMS THAT ENTER THE SCORE MULTIPLICATIVELY.
 *
 * Not the composites (`pAccept`, `pComplete`, `rRepeat`) — the leaves inside
 * them, because a composite hides what it is made of and hiding is how
 * `completionPrior` ended up as a global quality multiplier without anyone
 * choosing that.
 *
 * P_join's constituents are deliberately absent: they enter through a weighted
 * SUM, and a weighted sum of per-viewer terms is itself per-viewer. It is
 * multiplication by a viewer-independent factor that creates consensus, not
 * addition inside a viewer-dependent one.
 *
 * `tests/classification.test.ts` cross-checks this list against the source, so
 * it cannot quietly drift from what the code actually multiplies.
 */
export const MULTIPLICATIVE_LEAVES: readonly TermName[] = [
  'acceptLikelihood',      // via pAccept
  'completionPrior',       // via pComplete
  'freshness',             // via pComplete
  'repeatableContext',     // via rRepeat
  'rhythmOverlap',         // via rRepeat
  'exposureBoost',
  'demandMultiplier',
];

/**
 * Terms P_join sums. Listed so the source scan can tell "summed inside P_join"
 * from "multiplied into the product" — the whole distinction this build turns on.
 */
export const PJOIN_SUMMANDS: readonly TermName[] = [
  'categoryAffinity',
  'intentMatch',
  'proximity',
  'timeFit',
  'socialContext',
  'graphAffinity',
];

/**
 * How many of the multiplied leaves are global-quality terms.
 *
 * Currently FOUR, and that is the defect v1.8 exists to repair — stated as a
 * number the build can check rather than as a paragraph someone might disagree
 * with. `tests/classification.test.ts` asserts this count, so it can shrink
 * (as §1.2-1.4 land) but cannot silently grow.
 */
export const GLOBAL_QUALITY_MULTIPLIER_COUNT: number =
  MULTIPLICATIVE_LEAVES.filter((t) => TERM_CLASS[t] === 'global_quality').length;

/**
 * P_join — would this viewer tap "i'm in" if shown this card?
 *
 * A weighted sum of the taste/place/time features. Weights sum to 1 (asserted
 * at module load in constants.ts), so this is genuinely in [0, 1] and reads as
 * a probability rather than an arbitrary index.
 */
export function pJoin(f: FeatureVector, params: ResolvedParams): number {
  const w = params.pJoin;
  return (
    w.interestAffinity * f.categoryAffinity +
    w.intentMatch * f.intentMatch +
    w.proximity * f.proximity +
    w.timeFit * f.timeFit +
    w.socialContext * f.socialContext +
    w.graphAffinity * f.graphAffinity
  );
}

/**
 * P_accept — would this host say yes to this viewer?
 *
 * The two-sided half, and the thing that separates a marketplace ranker from a
 * feed ranker. Showing someone a card they will be declined for is worse than
 * showing them nothing: it costs them the ask.
 */
export function pAccept(f: FeatureVector): number {
  return f.acceptLikelihood;
}

/** P_complete — does this tandem actually happen? Host track record plus recency. */
export function pComplete(f: FeatureVector): number {
  const w = CONSTANTS.score.pComplete;
  return w.completionPrior * f.completionPrior + w.freshness * f.freshness;
}

/**
 * R_repeat — could this pairing become a habit?
 *
 * A multiplier in [1.0, 1.5], not a probability. Repeat-tandem rate is the
 * north star, so a pairing with recurrence potential is worth more than an
 * equally-likely one-off, and this is where that belief is expressed
 * numerically.
 */
export function rRepeat(f: FeatureVector): number {
  const w = CONSTANTS.score.rRepeat;
  return w.base + w.repeatableContext * f.repeatableContext + w.rhythmOverlap * f.rhythmOverlap;
}

/**
 * The exposure boost from the impression floor (v1 §5).
 *
 * A sequential one-card deck makes position 1 worth almost everything, so pure
 * score-sorting starves new posts and kills the flywheel. A post that peers have
 * lapped gets a temporary lift until it has had a fair look.
 */
export function exposureBoost(candidate: Candidate, peerMedianImpressions: number): number {
  const starved =
    candidate.impressionCount < CONSTANTS.retrieval.impressionFloor &&
    peerMedianImpressions >= CONSTANTS.retrieval.impressionPeer;
  return starved ? CONSTANTS.retrieval.impressionBoost : 1;
}

/**
 * S for one candidate, given its features.
 *
 * `params.funnelExponent` gates the three post-join factors. At 1 this is the
 * v1.5 product; at 0 each raises to the identity and S is P_join alone, which
 * is what ships while the ranker is shelved.
 *
 * Note that all four factors are still COMPUTED and returned regardless. They
 * go into the impression snapshot whether or not they influenced the order —
 * that is how the question "would the funnel have ranked this better?" stays
 * answerable offline instead of requiring another three months of data.
 */
export function scoreFeatures(
  f: FeatureVector,
  params: ResolvedParams,
  boost: number = 1,
  demand: DemandAdjustment = NEUTRAL_DEMAND,
): FunnelScore {
  const j = pJoin(f, params);
  const a = pAccept(f);
  const c = pComplete(f);
  const r = rRepeat(f);
  const e = params.funnelExponent;
  const base = j * Math.pow(a, e) * Math.pow(c, e) * Math.pow(r, e) * boost;
  return {
    pJoin: j,
    pAccept: a,
    pComplete: c,
    rRepeat: r,
    exposureBoost: boost,
    urgency: demand.urgency,
    overflow: demand.overflow,
    exhaustion: demand.exhaustion,
    score: base * demand.multiplier,
  };
}

/** Median impressions across the candidate pool, for the impression floor. */
export function peerMedianImpressions(candidates: readonly Candidate[]): number {
  if (candidates.length === 0) return 0;
  const counts = candidates.map((c) => c.impressionCount).sort((a, b) => a - b);
  const mid = Math.floor(counts.length / 2);
  if (counts.length % 2 === 1) return counts[mid] as number;
  return (((counts[mid - 1] as number) + (counts[mid] as number)) / 2);
}

/**
 * Score a whole pool. Sorted descending, ties broken by activityId so the
 * output is a total order and therefore reproducible.
 */
export function scoreCandidates(
  viewer: Viewer,
  candidates: readonly Candidate[],
  state: InterestState,
  now: Epoch,
  params: ResolvedParams,
): ScoredCandidate[] {
  const peerMedian = peerMedianImpressions(candidates);

  const scored = candidates.map((candidate) => {
    const features = computeFeatures(viewer, candidate, state, now);
    const funnel = scoreFeatures(
      features,
      params,
      exposureBoost(candidate, peerMedian),
      demandAdjustment(viewer, candidate, now, params),
    );
    return { candidate, features, funnel };
  });

  return scored.sort(
    (a, b) =>
      b.funnel.score - a.funnel.score ||
      a.candidate.activityId.localeCompare(b.candidate.activityId),
  );
}

/**
 * The fallback ordering, used when scoring throws.
 *
 * Nearest first, ties by freshest-posted, then by id. Proximity alone is a
 * defensible deck — it is the strongest single feature in the model — so a
 * degraded deck is a worse deck, not a broken one. The one thing it must never
 * be is empty.
 */
export function proximityOrder(candidates: readonly Candidate[]): Candidate[] {
  return candidates.slice().sort(
    (a, b) =>
      a.distanceMiles - b.distanceMiles ||
      b.postedAt - a.postedAt ||
      a.activityId.localeCompare(b.activityId),
  );
}
