/**
 * Retrieval — framework §3.1.
 *
 * Scoring answers "which of these is best". Retrieval answers the prior
 * question: which candidates does the scorer get to see at all? At 40 users the
 * whole pool fits in memory and retrieval looks pointless — but the source tags
 * it attaches are what make the funnel data interpretable later, and the quota
 * structure is what stops the deck collapsing onto one taste once the pool is
 * big enough for that to be possible.
 *
 * Every candidate leaves here tagged with the source that surfaced it. That tag
 * is written on the impression event, which is how you later answer "do explore
 * cards convert worse, and by how much".
 */

import { CONSTANTS } from './constants.js';
import { normalisedSalience, rankedMetrics } from './interest.js';
import { proximity } from './features.js';
import { seededShuffle, type Rng } from './random.js';
import type {
  ActivityId,
  Candidate,
  Epoch,
  InterestState,
  ResolvedParams,
  RetrievalSource,
  Viewer,
} from './types.js';

export interface RetrievalResult {
  /** Deduped candidates, each tagged with the source that claimed it first. */
  candidates: Candidate[];
  /** What each source contributed, before dedup. For debug output only. */
  bySource: Record<RetrievalSource, ActivityId[]>;
}

/** Sources in drain order. Earlier sources win ties during dedup. */
const SOURCE_ORDER: RetrievalSource[] = [
  'affinity',
  'proximity',
  'fresh_host',
  'graph',
  'random',
];

// ---------------------------------------------------------------------------
// Individual sources
// ---------------------------------------------------------------------------

/**
 * affinity — candidates matching the viewer's highest-salience metrics.
 *
 * Reads `salience`, not `interest`, so the novelty prior is what decides which
 * metrics get retrieved against. That is the difference between "show me more
 * coffee forever" and "show me coffee, and also the hiking thing I have tried
 * twice recently".
 */
function affinitySource(
  pool: readonly Candidate[],
  state: InterestState,
  limit: number,
): Candidate[] {
  const top = rankedMetrics(state)
    .filter((m) => m.salience >= CONSTANTS.retrieval.affinityMinSalience)
    .slice(0, CONSTANTS.retrieval.affinityMetricDepth)
    .map((m) => m.metric);

  if (top.length === 0) return [];
  const wanted = new Set(top);

  return pool
    .filter((c) => c.metrics.some((m) => wanted.has(m)))
    .map((c) => ({
      c,
      s: Math.max(...c.metrics.map((m) => normalisedSalience(state, m)), 0),
    }))
    .sort((a, b) => b.s - a.s || a.c.activityId.localeCompare(b.c.activityId))
    .slice(0, limit)
    .map((x) => x.c);
}

/**
 * proximity — nearest first, taste-blind.
 *
 * Deliberately independent of the interest model. It is the cold-start path
 * (a user with zero events still gets a full, sane deck) and the escape hatch
 * from a badly-fitted interest vector.
 */
function proximitySource(pool: readonly Candidate[], limit: number): Candidate[] {
  return pool
    .slice()
    .sort((a, b) => proximity(b) - proximity(a) || a.activityId.localeCompare(b.activityId))
    .slice(0, limit);
}

/**
 * fresh_host — posts by hosts this viewer has never been shown.
 *
 * The supply side of the flywheel. A host whose first three posts get no
 * impressions stops posting, and at 40 users you cannot afford to lose a host.
 * Ordered by proximity within the fresh set, so the guarantee does not cost the
 * viewer a card from across town.
 */
function freshHostSource(
  pool: readonly Candidate[],
  viewer: Viewer,
  limit: number,
): Candidate[] {
  const seen = new Set(viewer.seenHostIds);
  return pool
    .filter((c) => c.host.neverShownToViewer || !seen.has(c.hostId))
    .sort((a, b) => proximity(b) - proximity(a) || a.activityId.localeCompare(b.activityId))
    .slice(0, limit);
}

/**
 * graph — co-participation graph retrieval. STUB.
 *
 * Returns [] in v1.5 and its quota is redistributed. `graph_edges` is being
 * populated by the completion trigger from day one so there is history to turn
 * this on to.
 *
 * Intended implementation: hosts within three degrees of the viewer in
 * `graph_edges`, ordered by (degree asc, edge weight desc). Three degrees
 * because friends-of-friends have a decent likelihood of knowing each other and
 * beyond that the shared-interest prior washes out.
 */
function graphSource(
  _pool: readonly Candidate[],
  _viewer: Viewer,
  _now: Epoch,
  _limit: number,
): Candidate[] {
  return [];
}

/**
 * random — seeded uniform explore.
 *
 * The one thing that guarantees the model can be wrong about someone and
 * recover. Seeded on (userId, sessionId), so it is random across users and
 * sessions but stable within one — the deck does not reshuffle under the user's
 * thumb on a re-render.
 */
function randomSource(pool: readonly Candidate[], rng: Rng, limit: number): Candidate[] {
  return seededShuffle(pool, rng).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Scale the per-deck quotas up by the over-fetch factor and the requested deck
 * size, so slate assembly has spare cards to swap in when a constraint bites.
 */
export function scaledQuotas(
  deckSize: number,
  params: ResolvedParams,
): Record<RetrievalSource, number> {
  const base = params.quotas;
  const baseTotal = (Object.values(base) as number[]).reduce((a, b) => a + b, 0);
  if (baseTotal <= 0) {
    throw new Error('resolved retrieval quotas must not sum to zero');
  }
  const target = deckSize * CONSTANTS.retrieval.overFetchFactor;
  const out = {} as Record<RetrievalSource, number>;
  for (const source of SOURCE_ORDER) {
    // Ceil, so a source with a small but non-zero fraction still gets at least
    // one candidate. A source at exactly 0 gets 0 and is skipped entirely,
    // which is how village scale switches off explore without a branch.
    out[source] = Math.ceil((base[source] / baseTotal) * target);
  }
  return out;
}

/**
 * Run every source, dedupe, and tag.
 *
 * Two properties worth stating explicitly:
 *
 *   1. Nothing is dropped for being unwanted. Whatever the quotas leave over is
 *      appended at the end, tagged with the source that would have had it.
 *      Retrieval narrows the *order*, never the *set* — same rule as scoring.
 *      At beta scale that means the deck can always be filled.
 *
 *   2. A source that under-fills hands its slots to `backfillOrder`. The graph
 *      stub returning [] therefore costs nothing: its quota silently becomes
 *      more affinity and proximity.
 */
export function retrieve(
  viewer: Viewer,
  pool: readonly Candidate[],
  state: InterestState,
  rng: Rng,
  now: Epoch,
  deckSize: number,
  params: ResolvedParams,
): RetrievalResult {
  const quotas = scaledQuotas(deckSize, params);

  const raw: Record<RetrievalSource, Candidate[]> = {
    affinity: affinitySource(pool, state, quotas.affinity),
    proximity: proximitySource(pool, quotas.proximity),
    fresh_host: freshHostSource(pool, viewer, quotas.fresh_host),
    graph: graphSource(pool, viewer, now, quotas.graph),
    random: randomSource(pool, rng, quotas.random),
  };

  // Redistribute unfilled quota to the backfill sources, in order.
  let shortfall = 0;
  for (const source of SOURCE_ORDER) {
    shortfall += Math.max(0, quotas[source] - (raw[source]?.length ?? 0));
  }

  const taken = new Set<ActivityId>();
  const out: Candidate[] = [];
  const bySource = {} as Record<RetrievalSource, ActivityId[]>;

  for (const source of SOURCE_ORDER) {
    bySource[source] = (raw[source] ?? []).map((c) => c.activityId);
    for (const candidate of raw[source] ?? []) {
      if (taken.has(candidate.activityId)) continue;
      taken.add(candidate.activityId);
      out.push({ ...candidate, retrievalSource: source });
    }
  }

  if (shortfall > 0) {
    for (const source of CONSTANTS.retrieval.backfillOrder) {
      if (shortfall <= 0) break;
      const extra =
        source === 'affinity' ? affinitySource(pool, state, pool.length)
        : source === 'proximity' ? proximitySource(pool, pool.length)
        : randomSource(pool, rng, pool.length);
      for (const candidate of extra) {
        if (shortfall <= 0) break;
        if (taken.has(candidate.activityId)) continue;
        taken.add(candidate.activityId);
        out.push({ ...candidate, retrievalSource: source });
        bySource[source]?.push(candidate.activityId);
        shortfall--;
      }
    }
  }

  // Anything still unclaimed is appended rather than discarded, so that a
  // pathological quota configuration can never produce a short deck.
  for (const candidate of pool) {
    if (taken.has(candidate.activityId)) continue;
    taken.add(candidate.activityId);
    out.push({ ...candidate, retrievalSource: 'proximity' });
  }

  return { candidates: out, bySource };
}
