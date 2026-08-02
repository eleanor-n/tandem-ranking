/**
 * Slate assembly — framework §3.3, rewritten for v1.7 §3.2.
 *
 * Takes the scored pool and picks the deck. What happens here that pure
 * score-sorting will not do:
 *
 *   diversity   a decaying penalty on categories and hosts the SESSION has
 *               already shown, so the deck does not read as "we have decided
 *               you are a coffee person"
 *   fairness    a fresh host is guaranteed a look in the top slots
 *   explore     a seeded epsilon swap, so the model can be wrong and recover
 *
 * The last two are off while the ranker is shelved (their parameters resolve to
 * zero); the first is the shipping behaviour.
 *
 * ---------------------------------------------------------------------------
 * What changed in v1.7, and why it was a specification bug rather than a tuning
 * one
 *
 * v1.6 enforced diversity with reserved slots: at most N of a category and M
 * per host, per deck of 8, with a relaxation ladder for when the pool was too
 * thin to satisfy them. Every one of those numbers was a fraction of a deck.
 *
 * But Discover shows ONE CARD AT A TIME. A user keeps tandeming until they
 * close the app and the pool does not reset. "At most 2 coffees per 8" never
 * binds in a three-card session, and in a forty-card session it stops meaning
 * anything at all — the cap applies to a window that does not exist.
 *
 * So the caps are gone, replaced by a multiplicative penalty over what the
 * session has already shown. That change buys three things:
 *
 *   * it works at ANY session length, with no cliff
 *   * it needs no reserved slot and displaces nothing
 *   * THE RELAXATION LADDER IS UNNECESSARY. A hard cap could make the deck come
 *     out short, so v1.6 needed machinery to give caps up one at a time in a
 *     documented order. A penalised card is still a card, so the deck can never
 *     be short in the first place. An entire failure mode stopped existing.
 *
 * The governing rule is unchanged and now holds structurally rather than by
 * effort: constraints reorder, they never shorten.
 */

import { CONSTANTS } from './constants.js';
import type { Rng } from './random.js';
import { EMPTY_SESSION, noteShown, sessionPenalty, type SessionShown } from './session.js';
import type { ResolvedParams, ScoredCandidate } from './types.js';

export interface SlateResult {
  cards: ScoredCandidate[];
  /**
   * Constraints that had to be given up to keep the deck full.
   *
   * Nearly always empty as of v1.7 — only the fresh-host guarantee can still be
   * relaxed, and only when the pool contains no fresh host at all. That is
   * information rather than a failure: it means supply has gone stale.
   */
  relaxations: string[];
}

/**
 * Greedy selection under the session penalties.
 *
 * The running counters start from what the SESSION has shown and are then
 * incremented as the deck is built, so the penalty applies both across cards
 * within this deck and across decks within this session. Those are the same
 * thing from the user's side — they are looking at one card after another and
 * do not know where one fetch ended and the next began — so treating them
 * differently would be an implementation detail leaking into the product.
 *
 * Ties keep the incoming order, which is already a total order (score, then
 * activityId), so the deck stays reproducible.
 */
function selectDeck(
  scored: readonly ScoredCandidate[],
  deckSize: number,
  params: ResolvedParams,
  shown: SessionShown,
): ScoredCandidate[] {
  const chosen: ScoredCandidate[] = [];
  const taken = new Set<number>();
  let running = shown;

  while (chosen.length < deckSize && taken.size < scored.length) {
    let bestIndex = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < scored.length; i++) {
      if (taken.has(i)) continue;
      const sc = scored[i] as ScoredCandidate;
      const adjusted = sc.funnel.score * sessionPenalty(
        running,
        { category: sc.candidate.category, hostId: sc.candidate.hostId },
        params.categoryPenalty,
        params.hostPenalty,
      );
      // Strict >, so the first of equal candidates wins and the incoming total
      // order is preserved.
      if (adjusted > bestScore) { bestScore = adjusted; bestIndex = i; }
    }

    if (bestIndex < 0) break;
    const picked = scored[bestIndex] as ScoredCandidate;
    taken.add(bestIndex);
    chosen.push(picked);
    running = noteShown(running, [{
      category: picked.candidate.category,
      hostId: picked.candidate.hostId,
    }]);
  }

  return chosen;
}

/**
 * Guarantee a fresh host in the top slots.
 *
 * A post from a host the viewer has never been shown is promoted into the top
 * window regardless of score — once per deck. It displaces the *lowest-scoring*
 * card in that window rather than the top one, so the cost of the guarantee is
 * paid by position 3, not position 1.
 *
 * If the deck contains no fresh-host card at all, the guarantee is recorded as
 * relaxed. That is information, not a failure: it means supply has gone stale.
 */
function ensureFreshHostInTop(
  cards: ScoredCandidate[],
  relaxations: string[],
  params: ResolvedParams,
): ScoredCandidate[] {
  // Inert when the fresh_host quota is 0 — which is village scale by design
  // (§2.3: nothing needs displacing when the whole pool gets shown, and urgency
  // already surfaces an unfilled new host's post), and also every deck while
  // the ranker is shelved. Recording the relaxation here would be noise.
  if (params.quotas.fresh_host <= 0) return cards;

  const topWindow = Math.min(CONSTANTS.slate.topSlots, cards.length);
  const alreadyThere = cards
    .slice(0, topWindow)
    .filter((c) => c.candidate.retrievalSource === 'fresh_host' || c.candidate.host.neverShownToViewer)
    .length;

  if (alreadyThere >= CONSTANTS.slate.minFreshHostInTop) return cards;

  const idx = cards.findIndex(
    (c, i) => i >= topWindow &&
      (c.candidate.retrievalSource === 'fresh_host' || c.candidate.host.neverShownToViewer),
  );

  if (idx === -1) {
    relaxations.push('minFreshHostInTop');
    return cards;
  }

  // Displace the weakest card currently inside the window.
  let weakest = 0;
  for (let i = 1; i < topWindow; i++) {
    if ((cards[i] as ScoredCandidate).funnel.score < (cards[weakest] as ScoredCandidate).funnel.score) {
      weakest = i;
    }
  }

  const out = cards.slice();
  const promoted = out[idx] as ScoredCandidate;
  const displaced = out[weakest] as ScoredCandidate;
  out[weakest] = promoted;
  out[idx] = displaced;
  return out;
}

/**
 * Explore epsilon (v1 §5).
 *
 * With probability `exploreEpsilon`, swap the configured position with a
 * uniformly random lower-ranked card. Uses the session Rng, so it is
 * deterministic given (userId, sessionId) — the same user reloading the same
 * session sees the same deck, but two sessions explore differently.
 *
 * Position 2 (index 1) rather than position 1: the top card carries most of the
 * session's value and should be the model's best guess.
 *
 * Zero while the ranker is shelved. It is the one piece of this file that a
 * user could perceive directly, as unexplained randomness, so it is also the
 * one that most needs data behind it before it ships.
 */
function applyExploreEpsilon(
  cards: ScoredCandidate[],
  rng: Rng,
  params: ResolvedParams,
): ScoredCandidate[] {
  const pos = CONSTANTS.slate.exploreSwapPosition;
  if (cards.length <= pos + 1) return cards;

  // Draw the epsilon coin unconditionally so that the Rng consumes the same
  // number of values whether or not the swap happens. Otherwise the sequence
  // desynchronises and determinism becomes deck-length-dependent.
  const roll = rng();
  const pick = rng();
  if (roll >= params.exploreEpsilon) return cards;

  const lowerCount = cards.length - (pos + 1);
  const target = pos + 1 + Math.floor(pick * lowerCount);

  const out = cards.slice();
  const a = out[pos] as ScoredCandidate;
  const b = out[target] as ScoredCandidate;
  out[pos] = b;
  out[target] = a;
  return out;
}

/** Assemble the deck: session penalties, then the fresh-host guarantee, then explore. */
export function assembleSlate(
  scored: readonly ScoredCandidate[],
  rng: Rng,
  params: ResolvedParams,
  deckSize: number = CONSTANTS.slate.deckSize,
  shown: SessionShown = EMPTY_SESSION,
): SlateResult {
  const relaxations: string[] = [];
  if (scored.length === 0) return { cards: [], relaxations };

  const size = Math.min(deckSize, scored.length);
  let cards = selectDeck(scored, size, params, shown);
  cards = ensureFreshHostInTop(cards, relaxations, params);
  cards = applyExploreEpsilon(cards, rng, params);

  return { cards, relaxations };
}
