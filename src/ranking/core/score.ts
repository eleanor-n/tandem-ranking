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
import { buildScoringContext, computeFeatures } from './features.js';
import { NEUTRAL_DEMAND, demandAdjustment, type DemandAdjustment } from './demand.js';
import { TERM_CLASS, assertNoGlobalQualityMultipliers, type TermName } from './classification.js';
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
  'acceptLikelihood',      // via pAccept — pairwise as of v1.8 §1.2
  'rhythmOverlap',         // via rRepeat — pairwise
  'exposureBoost',
  'demandMultiplier',
];

/**
 * Global-quality terms admitted at REDUCED MAGNITUDE — rank-normalised over the
 * pool and raised to a damping exponent below 1.
 *
 * THIS CATEGORY IS PROVISIONAL AND SHOULD BE VIEWED WITH SUSPICION.
 *
 * Damping does not change what a term depends on. A category's repeatability is
 * the same fact for every viewer no matter what power it is raised to, so this
 * term still creates consensus — just less of it. The category exists because
 * "dampen it" and "drop it" are both defensible and only a measurement
 * separates them, not because dampening launders a global term into a safe one.
 *
 * v1.8 §3.4 runs it both ways. If keeping it does not pay, the correct response
 * is `repeatableContextWeight: 0`, not a smaller exponent.
 */
export const DAMPENED_MULTIPLICANDS: readonly TermName[] = [
  'repeatableContextRank',  // via rRepeat
];

/**
 * Terms that reach the deck as an ORDERING KEY rather than as a factor
 * (v1.8 §1.3).
 *
 * A global-quality term is admissible this way because a sort key does not
 * compound: it separates the deck into two blocks and orders within them. It
 * cannot make a good host twice as visible on every card the way a multiplier
 * can. Declared separately from the multiplicands so the distinction is visible
 * rather than implied by absence.
 */
export const GATE_TERMS: readonly TermName[] = [
  'completionPrior',       // via pComplete
  'freshness',             // via pComplete
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
 * Was FOUR before v1.8, and is now ZERO: §1.2 restored `acceptLikelihood`'s
 * viewer-dependence, §1.3 turned `completionPrior`/`freshness` into a gate, and
 * §1.4 moved `repeatableContext` into the dampened list.
 *
 * Because it is zero, the load-time guard below is now ARMED. A future edit
 * that multiplies a global-quality term into the score crashes on import
 * rather than shipping.
 */
export const GLOBAL_QUALITY_MULTIPLIER_COUNT: number =
  MULTIPLICATIVE_LEAVES.filter((t) => TERM_CLASS[t] === 'global_quality').length;

// ARMED as of v1.8 §1.4. A comment saying "do not multiply global quality terms"
// survives one distracted afternoon; this does not.
assertNoGlobalQualityMultipliers(MULTIPLICATIVE_LEAVES);

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
export function rRepeat(f: FeatureVector, params: ResolvedParams): number {
  const w = CONSTANTS.score.rRepeat;

  // The two halves are different KINDS of thing and v1.8 §1.4 stopped treating
  // them alike.
  //
  //   rhythmOverlap is pairwise — do you and this host tend to be free at the
  //   same times. Different for every pair, so it creates no consensus. It
  //   keeps its multiplier untouched.
  //
  //   repeatableContext is a fact about a CATEGORY, identical for everyone.
  //   Rank-normalised over the pool and dampened, which reduces how much
  //   consensus it creates without pretending to remove it — a category's
  //   repeatability does not become viewer-dependent by being raised to a
  //   power. Whether the residue earns its place is a measurement (§3.4), and
  //   `repeatableContextWeight: 0` is the arm that drops it.
  const context = params.repeatableContextWeight > 0
    ? params.repeatableContextWeight *
      Math.pow(f.repeatableContextRank, params.repeatableContextDamping)
    : 0;

  return w.base + context + w.rhythmOverlap * f.rhythmOverlap;
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
  const r = rRepeat(f, params);
  const e = params.funnelExponent;

  // P_complete is COMPUTED but no longer MULTIPLIES (v1.8 §1.3). It is a gate;
  // see `belowCompletionFloor` below and `compareScored`.
  const base = j * Math.pow(a, e) * Math.pow(r, e) * boost;

  return {
    pJoin: j,
    pAccept: a,
    pComplete: c,
    rRepeat: r,
    exposureBoost: boost,
    urgency: demand.urgency,
    overflow: demand.overflow,
    exhaustion: demand.exhaustion,
    // Strictly below, so a floor of 0 gates nothing — which is what the ship
    // gate relies on.
    belowCompletionFloor: c < params.completionFloor,
    score: base * demand.multiplier,
  };
}

/**
 * The deck's total order.
 *
 *   1. above the completion floor, before below it
 *   2. score, descending
 *   3. activityId, so the order is total and reproducible
 *
 * The gate is a SORT KEY, never a filter. A post from a host who has flaked
 * four times running goes last; it does not disappear. That is the framework's
 * absolute rule — the score orders, time pills filter, an empty deck is a bug.
 *
 * Expressing it as a key rather than as a multiplier is also what keeps it out
 * of the §D3 defect. A "gate" written as `score *= 0.001` would be a
 * global-quality multiplier wearing a gate's clothes: it would compound
 * identically for every viewer, which is the exact property being repaired.
 */
export function compareScored(a: ScoredCandidate, b: ScoredCandidate): number {
  if (a.funnel.belowCompletionFloor !== b.funnel.belowCompletionFloor) {
    return a.funnel.belowCompletionFloor ? 1 : -1;
  }
  return (
    b.funnel.score - a.funnel.score ||
    a.candidate.activityId.localeCompare(b.candidate.activityId)
  );
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
 * Score a whole pool, in the order `compareScored` defines: above the
 * completion gate first, then by score, then by id so the result is a total
 * order and therefore reproducible.
 */
export function scoreCandidates(
  viewer: Viewer,
  candidates: readonly Candidate[],
  state: InterestState,
  now: Epoch,
  params: ResolvedParams,
): ScoredCandidate[] {
  const peerMedian = peerMedianImpressions(candidates);
  // Built once per pool. Global-quality terms are only admissible once
  // rank-normalised against the population they claim to rank within, and that
  // population is not visible from inside a per-candidate function.
  const context = buildScoringContext(candidates, params.hostAcceptDamping);

  const scored = candidates.map((candidate) => {
    const features = computeFeatures(viewer, candidate, state, now, context);
    const funnel = scoreFeatures(
      features,
      params,
      exposureBoost(candidate, peerMedian),
      demandAdjustment(viewer, candidate, now, params),
    );
    return { candidate, features, funnel };
  });

  return scored.sort(compareScored);
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
