/**
 * The orchestrator. The only public entry point into core/.
 *
 *   interest -> retrieval -> score -> slate -> explain
 *
 * Everything above is pure and independently testable; this file is the wiring,
 * plus the one piece of policy that cannot live anywhere else: what to do when
 * something throws.
 *
 * The contract with the caller is narrow on purpose:
 *   in   RankInput  (viewer, candidates, interest log, sessionId, now)
 *   out  RankResult (a Slate of cards with reason lines — and no numbers)
 *
 * `now` is a parameter. There is no clock in this module and there will not be
 * one; that is what makes a deck reproducible in a test.
 */

import { computeInterestState } from './interest.js';
import { assembleSlate } from './slate.js';
import { proximityOrder, scoreCandidates } from './score.js';
import { retrieve } from './retrieval.js';
import { selectReason } from './explain.js';
import { mulberry32, seedFor } from './random.js';
import { computeRegime, resolveParams } from './regime.js';
import { RANKER_ENABLED, applyShipGate } from './shipping.js';
import { EMPTY_SESSION } from './session.js';
import { SNAPSHOT_VERSION, buildSnapshotApp } from './snapshot.js';
import type { SnapshotApp } from './snapshot.js';
import { CONSTANTS } from './constants.js';
import type {
  ActivityId,
  Candidate,
  RankInput,
  RankOptions,
  RankResult,
  ResolvedParams,
  RetrievalSource,
  ScoreSnapshot,
  ScoredCandidate,
  SlateCard,
} from './types.js';

/** Reported when the ranker degrades, so the caller can count it. */
export type DegradeReason = { stage: string; error: unknown };

/**
 * Rank a pool into a deck.
 *
 * Never throws, never returns an empty deck for a non-empty pool. If any stage
 * fails, the whole thing falls back to proximity order — a worse deck, not a
 * broken one — and flags `slate.degraded` so the failure is visible in the
 * funnel data rather than silently eating the session.
 *
 * `onDegrade` is how the caller logs it. core/ has no logger, by construction.
 */
export function rank(
  input: RankInput,
  options: RankOptions = {},
  onDegrade?: (reason: DegradeReason) => void,
): RankResult {
  const deckSize = options.deckSize ?? CONSTANTS.slate.deckSize;
  const seed = seedFor(input.viewer.userId, input.sessionId);

  try {
    const rng = mulberry32(seed);

    // THE ONLY PLACE THE REGIME EXISTS.
    //
    // Resolved once per session, then passed down as plain numbers. Nothing
    // below this line can tell village from city, which is what stops the
    // adaptation degenerating into two code paths. If `regime` was not supplied
    // the reading is derived from the pool itself, so a first-ever session with
    // no stored coverage history still lands somewhere sensible rather than
    // defaulting to an arbitrary end of the scale.
    const regime = input.regime ?? computeRegime(
      {
        eligiblePostsPerWeek: input.candidates.length,
        cardsViewedPerWeek: null,
        weeksOfHistory: 0,
      },
      null,
    ).regime;

    // THE ONLY PLACE THE SHIP GATE IS READ.
    //
    // A parameter transformation, not a branch — see shipping.ts for why. The
    // shelved ranker is the live pipeline with different numbers, which is the
    // only kind of dormant code that still works when you wake it up.
    const params: ResolvedParams = {
      ...applyShipGate(resolveParams(regime)),
      ...(options.paramsOverride ?? {}),
    };

    const interest = computeInterestState(
      input.interestEvents, input.now, input.viewer.userId,
      { noveltyBoost: params.noveltyBoost },
    );

    const retrieved = retrieve(
      input.viewer, input.candidates, interest, rng, input.now, deckSize, params,
    );

    const scored = scoreCandidates(
      input.viewer, retrieved.candidates, interest, input.now, params,
    );

    const { cards, relaxations } = assembleSlate(
      scored, rng, params, deckSize, input.sessionShown ?? EMPTY_SESSION,
    );

    const slateCards: SlateCard[] = cards.map((sc, position) => ({
      activityId: sc.candidate.activityId,
      hostId: sc.candidate.hostId,
      category: sc.candidate.category,
      position,
      reason: selectReason(input.viewer, sc.candidate, sc.features, interest),
      retrievalSource: sc.candidate.retrievalSource ?? 'proximity',
    }));

    const result: RankResult = {
      slate: {
        userId: input.viewer.userId,
        sessionId: input.sessionId,
        cards: slateCards,
        degraded: false,
        computedAt: input.now,
      },
      // Always populated, debug or not. Instrumentation is the deliverable, not
      // a debugging affordance — and the whole feature set is here, including
      // every feature the shipped ordering ignored.
      snapshots: cards.map((sc) => snapshotOf(sc, regime, input.snapshotApp)),
    };

    // The numeric internals are opt-in and never reachable from a UI type.
    if (options.debug) {
      result.debug = {
        scored,
        interest,
        retrieval: retrieved.bySource as Record<RetrievalSource, ActivityId[]>,
        relaxations,
        seed,
        regime,
        params,
      };
    }

    return result;
  } catch (error) {
    onDegrade?.({ stage: 'rank', error });
    return fallbackResult(input, deckSize);
  }
}

/**
 * One impression's worth of telemetry.
 *
 * Everything computed, whether or not it was used. Resolved parameters are
 * omitted on purpose: they are a pure function of (`algo`, `regime`), so
 * writing them onto every row would duplicate onto ~thousands of impressions
 * something already reconstructable from a git tag.
 */
function snapshotOf(
  sc: ScoredCandidate,
  regime: number,
  app?: Partial<SnapshotApp> | null,
): ScoreSnapshot {
  return {
    v: SNAPSHOT_VERSION,
    computed: {
      features: sc.features,
      funnel: sc.funnel,
      regime,
      rankerEnabled: RANKER_ENABLED,
      algo: CONSTANTS.instrumentation.algoVersion,
    },
    // Always written, always complete, even when the caller supplies nothing.
    // An un-integrated row is still a well-formed row, which is what lets a
    // later reader tell "unavailable" from "predates the field".
    app: buildSnapshotApp(app),
  };
}

/**
 * The floor. Proximity-ordered, canned category reason lines, no interest model
 * involved. Uses nothing that can throw.
 *
 * Emits no snapshots: there are no features here to snapshot, and writing empty
 * ones would put rows in the training set that look like measurements and are
 * not. A degraded deck is visible in the data as impressions with a null
 * `score_snapshot`, which is exactly what it is.
 */
function fallbackResult(input: RankInput, deckSize: number): RankResult {
  const ordered: Candidate[] = proximityOrder(input.candidates).slice(0, deckSize);

  return {
    snapshots: [],
    slate: {
      userId: input.viewer.userId,
      sessionId: input.sessionId,
      cards: ordered.map((candidate, position) => ({
        activityId: candidate.activityId,
        hostId: candidate.hostId,
        category: candidate.category,
        position,
        reason: {
          kind: 'category_fallback' as const,
          text: `${candidate.category.replace(/_/g, ' ')}, nearby.`,
          strength: 0,
          vars: { category: candidate.category.replace(/_/g, ' ') },
        },
        retrievalSource: candidate.retrievalSource ?? ('proximity' as const),
      })),
      degraded: true,
      computedAt: input.now,
    },
  };
}
