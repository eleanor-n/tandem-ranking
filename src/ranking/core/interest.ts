/**
 * The interest state model — framework §1.1–1.4 and §1.7.
 *
 * An append-only event log folds into a per-metric vector. The fold is a pure
 * function of (events, now): no clock, no I/O, no hidden state. That is what
 * makes `user_interest_state` safely a cache — it can always be thrown away
 * and rebuilt from `interest_events` alone.
 *
 * The three ideas, deliberately kept as three separate testable functions:
 *   decay        — evidence gets weaker with age, per-source half-life  (§1.2)
 *   saturation   — the 40th coffee tells you almost nothing new         (§1.3)
 *   novelty      — thin, fresh interests get an exploration bonus       (§1.4)
 */

import { CONSTANTS } from './constants.js';
import { hashIdSet } from './random.js';
import type {
  Epoch,
  EvidenceContribution,
  InterestEvent,
  InterestSource,
  InterestState,
  MetricSlug,
  MetricState,
  Unit,
  UserId,
} from './types.js';

const MS_PER_DAY = 86_400_000;

/**
 * Density-dependent inputs to the fold.
 *
 * `noveltyBoost` moves with density (1.0 village, 2.5 city) because novelty is
 * unmeasurable on three events. It is passed in rather than read from CONSTANTS
 * so that interest.ts stays unaware the regime exists — and so that a cached
 * vector can be invalidated when it changes, which isCacheFresh handles.
 */
export interface InterestOptions {
  noveltyBoost?: number;
}

// ---------------------------------------------------------------------------
// The three primitives
// ---------------------------------------------------------------------------

/**
 * Exponential decay by half-life. An event exactly one half-life old
 * contributes exactly half its strength; two half-lives, a quarter.
 *
 * `halfLifeDays: Infinity` means no decay. Negative ages (an event timestamped
 * in the future, which clock skew on a phone absolutely will produce) are
 * clamped to zero rather than amplified.
 */
export function decayFactor(ageDays: number, halfLifeDays: number): Unit {
  if (!Number.isFinite(halfLifeDays)) return 1;
  if (halfLifeDays <= 0) return 0;
  const age = Math.max(0, ageDays);
  return Math.pow(0.5, age / halfLifeDays);
}

/**
 * Saturation. sat(x) = x / (x + k), mapping unbounded evidence into [0, 1)
 * with diminishing returns.
 *
 * k is the amount of evidence that reaches 0.5. Below k, extra evidence moves
 * the needle a lot; above it, barely at all — which is the point. Someone who
 * has done forty coffee tandems is not "more into coffee" than someone who has
 * done thirty; they are both just into coffee.
 */
export function sat(x: number, k: number = CONSTANTS.interest.saturationK): Unit {
  if (x <= 0) return 0;
  return x / (x + k);
}

/**
 * The novelty prior — the anti-homophily term.
 *
 * novelty = recency x underExploration
 *
 *   recency          exp(-weightedMeanAgeDays / tau). Recent evidence only.
 *   underExploration k / (n + k), i.e. 1 - sat(n). High when there are few
 *                    events, collapsing toward 0 as evidence accumulates.
 *
 * The product is an optimism-under-uncertainty bonus in the UCB sense: it is
 * large exactly when the model has a fresh hint and not enough data to trust
 * its own conclusion. Two events from last week score high; forty events
 * smeared over seven months score near zero even though they are the stronger
 * evidence — and that asymmetry is deliberate, because the strong one is
 * already going to win on `interest` alone.
 */
export function noveltyTerm(
  weightedMeanAgeDays: number,
  eventCount: number,
  k: number = CONSTANTS.interest.saturationK,
  tauDays: number = CONSTANTS.interest.noveltyRecencyTauDays,
): Unit {
  if (eventCount <= 0) return 0;
  const recency = Math.exp(-Math.max(0, weightedMeanAgeDays) / tauDays);
  const underExploration = k / (eventCount + k);
  return recency * underExploration;
}

/**
 * Combine evidence strength with the novelty bonus.
 *
 * `interest` stays a clean [0, 1] measure of "how much evidence is there".
 * `salience` is what actually orders metrics and feeds categoryAffinity. Keeping
 * them separate means the explanation layer can say "you keep saying yes to
 * coffee" using interest, while retrieval uses salience and still surfaces the
 * hiking thing you tried twice last week.
 */
export function salienceOf(
  interest: Unit,
  novelty: Unit,
  noveltyBoost: number = CONSTANTS.interest.noveltyBoostDefault,
): number {
  return interest * (1 + noveltyBoost * novelty);
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

function specFor(source: InterestSource) {
  const spec = CONSTANTS.interest.sources[source];
  if (spec) return spec;
  // Unknown source: contribute nothing rather than throw. A backend that starts
  // writing a source this build has never heard of must not brick the deck.
  return {
    weight: 0,
    halfLifeDays: CONSTANTS.interest.unknownSourceHalfLifeDays,
    note: 'unknown source',
  };
}

/**
 * Fold an event log into the full interest vector as of `now`.
 *
 * Returns provenance alongside the numbers: for each metric, the events that
 * contributed most. This cannot be reconstructed after the fact — once the sum
 * exists, the summands are gone — so the explanation layer has to be served
 * here or not at all.
 */
export function computeInterestState(
  events: readonly InterestEvent[],
  now: Epoch,
  userId?: UserId,
  options: InterestOptions = {},
): InterestState {
  const noveltyBoost = options.noveltyBoost ?? CONSTANTS.interest.noveltyBoostDefault;
  const acc = new Map<MetricSlug, {
    pos: number;
    neg: number;
    count: number;
    ageWeightSum: number;   // sum of |contribution|
    ageWeightedSum: number; // sum of |contribution| * ageDays
    lastEventAt: Epoch | null;
    contributions: EvidenceContribution[];
  }>();

  for (const event of events) {
    const spec = specFor(event.source);
    const ageDays = (now - event.createdAt) / MS_PER_DAY;
    const decay = decayFactor(ageDays, spec.halfLifeDays);
    const magnitude = spec.weight * (event.weight ?? 1) * decay;

    // A zero-weight source (expand, in v1.5) contributes nothing and is not
    // counted as evidence — including it would inflate eventCount and suppress
    // the novelty bonus for a signal the model is not actually using.
    if (magnitude < CONSTANTS.interest.minContribution) continue;

    let entry = acc.get(event.metric);
    if (!entry) {
      entry = {
        pos: 0, neg: 0, count: 0,
        ageWeightSum: 0, ageWeightedSum: 0,
        lastEventAt: null, contributions: [],
      };
      acc.set(event.metric, entry);
    }

    if (event.polarity < 0) entry.neg += magnitude;
    else entry.pos += magnitude;

    entry.count += 1;
    entry.ageWeightSum += magnitude;
    entry.ageWeightedSum += magnitude * Math.max(0, ageDays);
    if (entry.lastEventAt === null || event.createdAt > entry.lastEventAt) {
      entry.lastEventAt = event.createdAt;
    }

    entry.contributions.push({
      eventId: event.id,
      source: event.source,
      metric: event.metric,
      createdAt: event.createdAt,
      contribution: event.polarity * magnitude,
      decayFactor: decay,
      ...(event.activityId ? { activityId: event.activityId } : {}),
    });
  }

  const metrics: Record<MetricSlug, MetricState> = {};

  for (const [metric, entry] of acc) {
    const interest = clamp01(
      sat(entry.pos) - CONSTANTS.interest.negativeEvidenceScale * sat(entry.neg),
    );

    // Contribution-weighted mean age: a metric whose evidence is mostly old
    // reads as old even if one recent event is attached to it.
    const meanAgeDays = entry.ageWeightSum > 0
      ? entry.ageWeightedSum / entry.ageWeightSum
      : 0;

    const novelty = noveltyTerm(meanAgeDays, entry.count);

    entry.contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    metrics[metric] = {
      metric,
      rawPositive: entry.pos,
      rawNegative: entry.neg,
      interest,
      novelty,
      confidence: sat(entry.count),
      salience: salienceOf(interest, novelty, noveltyBoost),
      eventCount: entry.count,
      lastEventAt: entry.lastEventAt,
      topContributors: entry.contributions.slice(
        0, CONSTANTS.interest.topContributorsPerMetric,
      ),
    };
  }

  return {
    userId: userId ?? events[0]?.userId ?? '',
    metrics,
    computedAt: now,
    eventCount: events.length,
    eventsHash: hashIdSet(events.map((e) => e.id)),
    paramsFingerprint: `nb:${noveltyBoost.toFixed(4)}`,
    version: CONSTANTS.interest.stateVersion,
  };
}

/**
 * Rebuild the interest state from the event log alone, ignoring any cache.
 *
 * This exists to be called, not just to document intent: it is what proves
 * `user_interest_state` is disposable. `tests/interest.test.ts` asserts that a
 * cached state and a rebuilt one agree, which is the invariant that lets the
 * cache be truncated at any time without an incident.
 */
export function rebuildInterestStateFromEvents(
  events: readonly InterestEvent[],
  now: Epoch,
  userId?: UserId,
  options: InterestOptions = {},
): InterestState {
  return computeInterestState(events, now, userId, options);
}

/**
 * Is a cached state still usable at `now`?
 *
 * Two ways to be stale: new events arrived (count or fingerprint differs), or
 * enough wall-clock passed that decay has moved underneath it. The second one
 * is easy to forget and is why `computedAt` is stored.
 */
export function isCacheFresh(
  cached: InterestState | null,
  liveEventIds: readonly string[],
  now: Epoch,
  paramsFingerprint?: string,
): boolean {
  if (!cached) return false;
  if (cached.version !== CONSTANTS.interest.stateVersion) return false;
  // A vector computed under a different noveltyBoost is wrong, not stale-ish.
  // Without this check a user crossing the hysteresis band keeps serving an
  // interest vector built with the old novelty weighting until some unrelated
  // event happens to invalidate it.
  if (paramsFingerprint !== undefined && cached.paramsFingerprint !== paramsFingerprint) {
    return false;
  }
  if (cached.eventCount !== liveEventIds.length) return false;
  if (cached.eventsHash !== hashIdSet(liveEventIds)) return false;
  const ageMinutes = (now - cached.computedAt) / 60_000;
  if (ageMinutes < 0) return false; // clock went backwards; do not trust it
  return ageMinutes <= CONSTANTS.interest.cacheMaxAgeMinutes;
}

// ---------------------------------------------------------------------------
// Reading the vector
// ---------------------------------------------------------------------------

/** Metrics ordered by salience, highest first. Ties broken by slug for determinism. */
export function rankedMetrics(state: InterestState): MetricState[] {
  return Object.values(state.metrics).sort(
    (a, b) => b.salience - a.salience || a.metric.localeCompare(b.metric),
  );
}

/**
 * Salience normalised into [0, 1] across the user's own metrics.
 *
 * Normalised per-user, not globally: the question a feature asks is "is this
 * one of the things *you* are into", which is relative to the rest of your
 * vector, not to some absolute scale that a heavy user would dominate.
 */
export function normalisedSalience(state: InterestState, metric: MetricSlug): Unit {
  const target = state.metrics[metric];
  if (!target) return 0;
  let max = 0;
  for (const m of Object.values(state.metrics)) {
    if (m.salience > max) max = m.salience;
  }
  if (max <= 0) return 0;
  return clamp01(target.salience / max);
}

/** Total events folded in, across all metrics. Drives the explicit/behavioural blend. */
export function totalEvidenceCount(state: InterestState): number {
  let total = 0;
  for (const m of Object.values(state.metrics)) total += m.eventCount;
  return total;
}

// ---------------------------------------------------------------------------
// Explicit statements (§1.7)
// ---------------------------------------------------------------------------

/**
 * Build the event row for "I'm into this" / "not for me".
 *
 * Structured and reversible by construction: it is an ordinary row in
 * `interest_events` with `source = 'explicit_statement'`, which the migration
 * makes uniquely keyed on (user, metric), user-selectable and user-deletable.
 * There is no NLP here and there is not going to be — the caller resolves free
 * text to a slug before this is reached.
 *
 * Purity note: this returns the row rather than writing it, and takes `now` and
 * `id` as parameters, because core/ may not touch a clock or a UUID generator.
 */
export function buildExplicitStatement(params: {
  id: string;
  userId: UserId;
  metric: MetricSlug;
  polarity: 1 | -1;
  now: Epoch;
}): InterestEvent {
  return {
    id: params.id,
    userId: params.userId,
    metric: params.metric,
    source: 'explicit_statement',
    polarity: params.polarity,
    // Fixed by spec — an explicit statement is an explicit statement.
    weight: CONSTANTS.interest.explicitStatementWeight,
    createdAt: params.now,
  };
}

// ---------------------------------------------------------------------------

function clamp01(x: number): Unit {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
