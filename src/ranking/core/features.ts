/**
 * The feature dictionary. Every function here returns a number in [0, 1] and is
 * pure: (viewer, candidate, interestState, now) in, a scalar out.
 *
 * All features are first-party in-app behaviour. Message content is never a
 * ranking signal and no off-app or contact-graph data is used. That is a
 * permanent constraint, not a v1.5 simplification.
 *
 * Every behavioural feature has a defined value under thin data — the system
 * degrades to "reasonable", never to "broken".
 */

import {
  ADJACENT_BUCKET_CREDIT,
  ADJACENT_SHAPES,
  CATEGORY_REPEATABILITY,
  CATEGORY_SHAPE,
  COMPATIBLE_FRIEND_WHO,
  CONSTANTS,
  DEFAULT_REPEATABILITY,
  IDEAL_SATURDAY_METRICS,
  TIME_BUCKET_ORDER,
} from './constants.js';
import { normalisedSalience, totalEvidenceCount } from './interest.js';
import type {
  ActivityShape,
  Candidate,
  Epoch,
  FeatureVector,
  InterestState,
  MetricSlug,
  TimeBucket,
  Unit,
  Viewer,
} from './types.js';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Taste
// ---------------------------------------------------------------------------

/** The metrics a viewer's onboarding answers imply, deduped. */
export function explicitMetrics(viewer: Viewer): Set<MetricSlug> {
  const out = new Set<MetricSlug>();
  for (const answer of viewer.idealSaturday) {
    for (const metric of IDEAL_SATURDAY_METRICS[answer] ?? []) out.add(metric);
  }
  return out;
}

/**
 * categoryAffinity — blend of stated taste and observed behaviour.
 *
 *   affinity = (1 - lambda) * explicit + lambda * behavioural
 *   lambda   = min(totalEvents / pivot, cap)
 *
 * A new user runs on their answers. An active user runs on what they actually
 * do. Because `cap` < 1 the stated signal never fully disappears, which is what
 * keeps a heavy coffee user from having the rest of their vector erased.
 *
 * The behavioural half reads `salience`, not `interest`, so the novelty prior
 * flows through into retrieval.
 */
export function categoryAffinity(
  viewer: Viewer,
  candidate: Candidate,
  state: InterestState,
): Unit {
  const stated = explicitMetrics(viewer);
  const explicit = candidate.metrics.some((m) => stated.has(m)) ? 1 : 0;

  let behavioural = 0;
  for (const metric of candidate.metrics) {
    const s = normalisedSalience(state, metric);
    if (s > behavioural) behavioural = s;
  }

  const lambda = Math.min(
    totalEvidenceCount(state) / CONSTANTS.features.behaviouralPivot,
    CONSTANTS.features.behaviouralCap,
  );

  return clamp01((1 - lambda) * explicit + lambda * behavioural);
}

/**
 * intentMatch — does the shape of this post match what the viewer said they
 * came here for? Exact / adjacent / mismatch, from a static table.
 *
 * A viewer with no stated intent gets the thin-data default rather than a zero;
 * "we don't know" must not read as "no".
 */
export function intentMatch(viewer: Viewer, candidate: Candidate): Unit {
  const want = viewer.tandemIntent;
  if (!want) return CONSTANTS.features.thinDataDefault;

  const have: ActivityShape = candidate.shape
    ?? CATEGORY_SHAPE[candidate.category]
    ?? 'one_off';

  if (want === have) return CONSTANTS.features.intentMatch.exact;
  const adjacent = ADJACENT_SHAPES.some(
    ([a, b]) => (a === want && b === have) || (b === want && a === have),
  );
  return adjacent
    ? CONSTANTS.features.intentMatch.adjacent
    : CONSTANTS.features.intentMatch.mismatch;
}

/**
 * socialContext — overlap between the viewer's and host's friend_who answers.
 * "Someone to do the thing with, not talk it to death" matching another of the
 * same is a real compatibility signal and costs nothing to compute.
 */
export function socialContext(viewer: Viewer, candidate: Candidate): Unit {
  const a = viewer.friendWho;
  const b = candidate.host.friendWho;
  if (!a || !b) return CONSTANTS.features.thinDataDefault;
  if (a === b) return CONSTANTS.features.socialContext.same;
  const compatible = COMPATIBLE_FRIEND_WHO.some(
    ([x, y]) => (x === a && y === b) || (y === a && x === b),
  );
  return compatible
    ? CONSTANTS.features.socialContext.compatible
    : CONSTANTS.features.socialContext.different;
}

// ---------------------------------------------------------------------------
// Place and time
// ---------------------------------------------------------------------------

/**
 * proximity — exp(-miles / 4). A decay curve, not a cliff, so a great match at
 * six miles can still beat a weak one at two. Propinquity is the strongest
 * predictor of friendship formation in the literature, which is why this gets
 * real weight rather than being a filter.
 */
export function proximity(candidate: Candidate): Unit {
  const miles = Math.max(0, candidate.distanceMiles);
  if (!Number.isFinite(miles)) return 0;
  return clamp01(Math.exp(-miles / CONSTANTS.features.proximityDecayMiles));
}

/** Distance in the ordered bucket list; 0 = same bucket, 1 = adjacent. */
function bucketDistance(a: TimeBucket, b: TimeBucket): number {
  const ia = TIME_BUCKET_ORDER.indexOf(a);
  const ib = TIME_BUCKET_ORDER.indexOf(b);
  if (ia < 0 || ib < 0) return Number.POSITIVE_INFINITY;
  return Math.abs(ia - ib);
}

/** Best match between one bucket and a set of them, with partial credit for adjacency. */
function bucketFit(target: TimeBucket, buckets: readonly TimeBucket[]): Unit | null {
  if (buckets.length === 0) return null;
  let best = 0;
  for (const b of buckets) {
    const d = bucketDistance(target, b);
    const score = d === 0 ? 1 : d === 1 ? ADJACENT_BUCKET_CREDIT : 0;
    if (score > best) best = score;
  }
  return best;
}

/**
 * timeFit — does this activity land in a bucket the viewer is historically out
 * in? Soft, with adjacency credit, because "usually a morning person" should
 * not hard-reject a midday thing.
 */
export function timeFit(viewer: Viewer, candidate: Candidate): Unit {
  const fit = bucketFit(candidate.timeBucket, viewer.activeBuckets);
  return fit ?? CONSTANTS.features.thinDataDefault;
}

/**
 * rhythmOverlap — do the viewer and host tend to be free at the same times?
 * This is the habit-formation signal: two people free on Tuesday evenings can
 * become a standing thing, which is the entire north star.
 */
export function rhythmOverlap(viewer: Viewer, candidate: Candidate): Unit {
  const v = viewer.activeBuckets;
  const h = candidate.host.activeBuckets;
  if (v.length === 0 || h.length === 0) return CONSTANTS.features.thinDataDefault;

  let best = 0;
  for (const vb of v) {
    const fit = bucketFit(vb, h) ?? 0;
    if (fit > best) best = fit;
  }
  return clamp01(best);
}

/**
 * freshness — exp(-hoursSincePosted / 48), floored at 0.3 so the deck does not
 * go stale but old posts are not buried alive either.
 */
export function freshness(candidate: Candidate, now: Epoch): Unit {
  const hours = Math.max(0, (now - candidate.postedAt) / MS_PER_HOUR);
  const raw = Math.exp(-hours / CONSTANTS.features.freshnessDecayHours);
  return clamp01(Math.max(CONSTANTS.features.freshnessFloor, raw));
}

// ---------------------------------------------------------------------------
// Host-side
// ---------------------------------------------------------------------------

/** Beta-smoothed rate. A brand-new host starts at 0.5 rather than 0 or 1. */
function smoothedRate(successes: number, trials: number, alpha: number, beta: number): Unit {
  const s = Math.max(0, successes);
  const t = Math.max(s, Math.max(0, trials));
  return clamp01((s + alpha) / (t + alpha + beta));
}

/**
 * hostReliability — prior-smoothed accept rate, lifted slightly for verified
 * hosts. `verified` here means the AWS Rekognition face check passed; it is an
 * identity signal, not a taste one, and it is capped so it can never dominate.
 */
export function hostReliability(candidate: Candidate): Unit {
  const base = smoothedRate(
    candidate.host.acceptCount,
    candidate.host.requestCount,
    CONSTANTS.features.acceptPriorAlpha,
    CONSTANTS.features.acceptPriorBeta,
  );
  const boosted = candidate.host.verified
    ? base * CONSTANTS.features.verifiedHostBoost
    : base;
  return clamp01(boosted);
}

// ---------------------------------------------------------------------------
// P_accept — the two-sided half (v1.8 §1.2)
// ---------------------------------------------------------------------------

/**
 * How experienced a requester this viewer is. Saturating, so the fortieth
 * tandem does not read as forty times the first.
 *
 * Neutral is 0: no history is no bonus, never a penalty. A new user has not
 * done anything wrong.
 */
export function viewerExperience(viewer: Viewer): Unit {
  const n = Math.max(0, viewer.completedTandems ?? 0);
  const k = CONSTANTS.features.acceptance.experienceK;
  return clamp01(n / (n + k));
}

/**
 * Did they turn up. The only sub-feature that answers the question a host is
 * actually asking, which is why it carries the largest weight.
 *
 * Beta-smoothed on the same prior shape as everything else here, so a viewer
 * with no accepted requests sits at exactly 0.5 — the neutral value — rather
 * than at 1.0 (unearned) or 0.0 (punished for being new).
 */
export function viewerFollowThrough(viewer: Viewer): Unit {
  const accepted = Math.max(0, viewer.acceptedRequests ?? 0);
  if (accepted === 0) return CONSTANTS.features.thinDataDefault;
  const shown = Math.max(0, accepted - Math.max(0, viewer.noShows ?? 0));
  return smoothedRate(
    shown,
    accepted,
    CONSTANTS.features.acceptPriorAlpha,
    CONSTANTS.features.acceptPriorBeta,
  );
}

/**
 * Does the viewer post this kind of thing themselves.
 *
 * The load-bearing one for ORDERING. The other viewer-side features are the
 * same number for every card in the deck, so on their own they rescale the
 * whole deck uniformly and change nothing about its order. This one varies
 * card to card.
 *
 * No posting history at all returns neutral rather than 0 — a viewer who has
 * never hosted is not a viewer who hosts the wrong things.
 */
export function categoryFamiliarity(viewer: Viewer, candidate: Candidate): Unit {
  const posted = viewer.postedCategories;
  if (!posted || posted.length === 0) return CONSTANTS.features.thinDataDefault;
  return posted.includes(candidate.category) ? 1 : 0;
}

/**
 * Co-participation distance viewer -> host, as an acceptance signal. STUB.
 *
 * Returns exactly neutral, so its weight contributes exactly zero deviation.
 * That is safe here in a way it was NOT safe in P_join (see INFERENCES §F2):
 * this form is centred on neutral and sums deviations, so an inert term adds 0.
 * P_join renormalises weights, so an inert term there would have survived
 * renormalisation and depressed every score. Same stub, opposite consequence,
 * because of the shape of the expression it sits in.
 *
 * Turning it on is one line in this function and nothing else.
 */
export function graphCloseness(
  _viewer: Viewer,
  _candidate: Candidate,
): Unit {
  return CONSTANTS.features.thinDataDefault;
}

/**
 * How far this viewer is from a neutral requester, in [-1, 1] before clamping.
 *
 * A deviation, not a score. Every sub-feature is measured against its own
 * neutral, so a viewer with no history anywhere produces exactly 0 and
 * `viewerAcceptability` comes out at exactly 1.0 — no cold-start penalty, and
 * no cold-start bonus either.
 */
export function viewerDeviation(viewer: Viewer, candidate: Candidate): number {
  const w = CONSTANTS.features.acceptance.weights;
  const neutral = CONSTANTS.features.thinDataDefault;

  const raw =
    w.verification * ((viewer.verified ? 1 : 0) - 0) +
    w.experience * (viewerExperience(viewer) - 0) +
    w.followThrough * (viewerFollowThrough(viewer) - neutral) +
    w.categoryFamiliarity * (categoryFamiliarity(viewer, candidate) - neutral) +
    w.graphCloseness * (graphCloseness(viewer, candidate) - neutral);

  return clamp(
    raw,
    CONSTANTS.features.acceptance.deviationFloor,
    CONSTANTS.features.acceptance.deviationCeiling,
  );
}

/**
 * acceptLikelihood — P_accept. Would THIS host say yes to THIS viewer?
 *
 *   P_accept = hostRank^rho x (1 + pickiness x viewerDeviation)
 *   pickiness = 1 - hostRank
 *
 * `hostRank` is rank-normalised hostReliability over the live pool, supplied by
 * the caller because it needs population context this function does not have.
 * Absent (no context, as in a unit test), it falls back to the raw smoothed
 * rate and the term degrades to something close to the v1.7 behaviour.
 *
 * THE PICKINESS TERM IS THE REPAIR. Without it, a viewer's reputation is one
 * number applied to every card they see: it scales the whole deck and reorders
 * nothing, so the ordering would still be `hostRank^rho` — the same global
 * consensus, merely quieter. Scaling the viewer's deviation by how selective
 * the host is makes the term genuinely conditional on the pair: a host who
 * accepts everyone does not care about your record, a selective one does.
 *
 * Auto-accept for a trusted viewer is a certainty rather than a probability, so
 * it still short-circuits to 1.
 */
export function acceptLikelihood(
  viewer: Viewer,
  candidate: Candidate,
  hostRank?: number,
): Unit {
  if (candidate.autoAcceptTrusted && viewer.trustedByHostIds.includes(candidate.hostId)) {
    return 1;
  }

  const rank = hostRank ?? hostReliability(candidate);
  const damped = Math.pow(clamp01(rank), CONSTANTS.features.acceptance.hostAcceptDamping);
  const pickiness = 1 - clamp01(rank);

  return clamp01(damped * (1 + pickiness * viewerDeviation(viewer, candidate)));
}

/**
 * completionPrior — the host's historical completion rate, decayed by lead
 * time. Posts more than five days out decay toward 0.6, because distant plans
 * die and a deck full of them is a deck full of things that will not happen.
 */
export function completionPrior(candidate: Candidate, now: Epoch): Unit {
  const base = smoothedRate(
    candidate.host.completedCount,
    candidate.host.hostedCount,
    CONSTANTS.features.completionPriorAlpha,
    CONSTANTS.features.completionPriorBeta,
  );

  const leadDays = Math.max(0, (candidate.startsAt - now) / MS_PER_DAY);
  const excess = Math.max(0, leadDays - CONSTANTS.features.leadTimeDecayDays);
  if (excess === 0) return base;

  // Exponential approach to the floor, with the same time constant as the
  // threshold itself: five days past the threshold gets you ~63% of the way down.
  const floor = CONSTANTS.features.distantPlanFloor;
  const t = 1 - Math.exp(-excess / CONSTANTS.features.leadTimeDecayDays);
  return clamp01(base * (1 - t) + base * floor * t);
}

/**
 * repeatableContext — the platonic-specific weighting, and the most
 * product-shaping number in the system.
 *
 * Routine categories (coffee, study, fitness, errands, markets) score 1.0;
 * occasional ones 0.5; one-offs 0.25. This deliberately makes a Tuesday study
 * session outrank a Saturday concert for most users. It is a strategic bet that
 * habit beats excitement for friendship formation — right by the research and
 * by the north star, but it shapes the product's feel, and it is veto-able in
 * one edit to CATEGORY_REPEATABILITY.
 */
export function repeatableContext(candidate: Candidate): Unit {
  const cls = CATEGORY_REPEATABILITY[candidate.category] ?? DEFAULT_REPEATABILITY;
  return CONSTANTS.features.repeatableContext[cls];
}

// ---------------------------------------------------------------------------
// Graph — STUB
// ---------------------------------------------------------------------------

/**
 * graphAffinity — co-participation proximity between viewer and host.
 *
 * NOT IMPLEMENTED. Returns 0, and the resolved graphAffinity weight is 0 at
 * both ends of the continuum, so it contributes nothing. Declaring a non-zero
 * weight on an always-zero feature would not be inert — the weight survives
 * renormalisation and would cap P_join below 1 for everyone.
 *
 * v1.7: `graph_edges` is a DERIVED AGGREGATE over completed `tandems`, rebuilt
 * by `rebuild_graph_edges()`, not a triggered table. The history is therefore
 * never missing — it can be recomputed from `tandems` at any time — which is a
 * strictly better position to switch this on from than the v1.5 arrangement,
 * where a trigger that silently never fired left the table empty for months.
 *
 * Intended implementation: shortest path length between viewer and host over
 * `graph_edges`, capped at three degrees, mapped through a decay — a
 * friend-of-a-friend scores meaningfully, a stranger four hops out scores zero.
 * Switching it on means: implement this, give it a weight taken *out of*
 * categoryAffinity and proximity (not added on top, or P_join drifts above 1),
 * and implement the `graph` retrieval source in retrieval.ts.
 *
 * The signature is deliberately the final one, so turning it on is a change to
 * this function's body and nothing else.
 */
export function graphAffinity(
  _viewer: Viewer,
  _candidate: Candidate,
  _now: Epoch,
): Unit {
  return 0;
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Population context (v1.8 §1.2, §1.4)
// ---------------------------------------------------------------------------

/**
 * The population-level facts a single candidate's features cannot see.
 *
 * Global-quality terms are only allowed in the score once they have been
 * rank-normalised against the population they claim to rank within — which
 * means the scorer needs the population, which means it cannot be computed
 * inside a per-candidate function. Hence a context object, built once per
 * `scoreCandidates` call.
 *
 * The population here is the live candidate pool: hosts with an open post. That
 * is a good proxy for "active hosts" and, more importantly, it is available
 * client-side without a second query. Documented rather than silently assumed.
 */
export interface ScoringContext {
  /** hostId -> rank-normalised hostReliability in (0, 1]. Ties share a rank. */
  hostReliabilityRank: ReadonlyMap<string, number>;
  /** category -> rank-normalised repeatableContext in (0, 1]. Ties share a rank. */
  repeatableContextRank: ReadonlyMap<string, number>;
}

/**
 * Rank-normalise a set of keyed values into (0, 1].
 *
 * Why ranks rather than raw values: a raw rate is not scale-invariant. An 0.8
 * accept rate is unremarkable in a pool where everyone is at 0.9 and
 * exceptional in one where everyone is at 0.4, and the raw term cannot tell the
 * difference. Ranks can. It also bounds the spread, which is what stops one
 * host's advantage compounding into a monopoly.
 *
 * Ties share the average rank, so twenty hosts with identical records all get
 * the same value rather than an arbitrary ordering being invented for them.
 */
export function rankNormalise(values: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const n = values.size;
  if (n === 0) return out;

  const sorted = [...values.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));

  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && (sorted[j + 1] as [string, number])[1] === (sorted[i] as [string, number])[1]) j++;
    // Average 1-based rank across the tie group, normalised to (0, 1].
    const rank = (i + j + 2) / 2 / n;
    for (let k = i; k <= j; k++) out.set((sorted[k] as [string, number])[0], rank);
    i = j + 1;
  }

  return out;
}

/** Build the context for one pool. */
export function buildScoringContext(candidates: readonly Candidate[]): ScoringContext {
  const hostValues = new Map<string, number>();
  const categoryValues = new Map<string, number>();

  for (const candidate of candidates) {
    if (!hostValues.has(candidate.hostId)) {
      hostValues.set(candidate.hostId, hostReliability(candidate));
    }
    if (!categoryValues.has(candidate.category)) {
      categoryValues.set(candidate.category, repeatableContext(candidate));
    }
  }

  return {
    hostReliabilityRank: rankNormalise(hostValues),
    repeatableContextRank: rankNormalise(categoryValues),
  };
}

/**
 * Compute the whole feature vector for one candidate.
 *
 * `context` is optional so that a unit test can score one card without
 * assembling a population. Without it the global-quality terms fall back to
 * their raw values, which is the v1.7 behaviour — fine for testing a single
 * feature, wrong for producing a deck, and `scoreCandidates` always supplies it.
 */
export function computeFeatures(
  viewer: Viewer,
  candidate: Candidate,
  state: InterestState,
  now: Epoch,
  context?: ScoringContext,
): FeatureVector {
  const hostRank = context?.hostReliabilityRank.get(candidate.hostId);

  return {
    categoryAffinity: categoryAffinity(viewer, candidate, state),
    intentMatch: intentMatch(viewer, candidate),
    proximity: proximity(candidate),
    timeFit: timeFit(viewer, candidate),
    socialContext: socialContext(viewer, candidate),
    hostReliability: hostReliability(candidate),
    acceptLikelihood: acceptLikelihood(viewer, candidate, hostRank),
    completionPrior: completionPrior(candidate, now),
    repeatableContext: repeatableContext(candidate),
    rhythmOverlap: rhythmOverlap(viewer, candidate),
    freshness: freshness(candidate, now),
    graphAffinity: graphAffinity(viewer, candidate, now),
  };
}

function clamp01(x: number): Unit {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}
