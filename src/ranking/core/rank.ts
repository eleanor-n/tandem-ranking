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
import { CONSTANTS } from './constants.js';
import type {
  ActivityId,
  Candidate,
  RankInput,
  RankOptions,
  RankResult,
  RetrievalSource,
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

    const interest = computeInterestState(
      input.interestEvents, input.now, input.viewer.userId,
    );

    const retrieved = retrieve(
      input.viewer, input.candidates, interest, rng, input.now, deckSize,
    );

    const scored = scoreCandidates(
      input.viewer, retrieved.candidates, interest, input.now,
    );

    const { cards, relaxations } = assembleSlate(scored, rng, deckSize);

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
    };

    // The numeric internals are opt-in and never reachable from a UI type.
    if (options.debug) {
      result.debug = {
        scored,
        interest,
        retrieval: retrieved.bySource as Record<RetrievalSource, ActivityId[]>,
        relaxations,
        seed,
      };
    }

    return result;
  } catch (error) {
    onDegrade?.({ stage: 'rank', error });
    return fallbackResult(input, deckSize);
  }
}

/**
 * The floor. Proximity-ordered, canned category reason lines, no interest model
 * involved. Uses nothing that can throw.
 */
function fallbackResult(input: RankInput, deckSize: number): RankResult {
  const ordered: Candidate[] = proximityOrder(input.candidates).slice(0, deckSize);

  return {
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
