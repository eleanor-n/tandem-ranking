/**
 * Slate assembly — framework §3.3.
 *
 * Takes the scored pool and picks the deck. Three things happen here that pure
 * score-sorting will not do for you:
 *
 *   diversity   at most N of a category, at most one per host, so the deck does
 *               not read as "we have decided you are a coffee person"
 *   fairness    a fresh host is guaranteed a look in the top slots
 *   explore     a seeded epsilon swap, so the model can be wrong and recover
 *
 * The governing rule: constraints reorder, they never shorten. If a constraint
 * cannot be satisfied without dropping a card, the constraint is abandoned and
 * the relaxation is recorded. An empty or short deck is always a bug, never a
 * strongly-held opinion.
 */

import { CONSTANTS } from './constants.js';
import type { Rng } from './random.js';
import type { ScoredCandidate } from './types.js';

export interface SlateResult {
  cards: ScoredCandidate[];
  /** Constraints that had to be given up to keep the deck full. */
  relaxations: string[];
}

/** The diversity caps that can be individually given up. */
interface Caps {
  maxPerHost: number | null;
  maxPerCategory: number | null;
}

/** One greedy pass: take cards in score order, skipping any that break a cap. */
function greedyPick(
  scored: readonly ScoredCandidate[],
  deckSize: number,
  caps: Caps,
): ScoredCandidate[] {
  const perCategory = new Map<string, number>();
  const perHost = new Map<string, number>();
  const chosen: ScoredCandidate[] = [];

  for (const sc of scored) {
    if (chosen.length >= deckSize) break;
    const cat = sc.candidate.category;
    const host = sc.candidate.hostId;
    const catCount = perCategory.get(cat) ?? 0;
    const hostCount = perHost.get(host) ?? 0;

    if (caps.maxPerHost !== null && hostCount >= caps.maxPerHost) continue;
    if (caps.maxPerCategory !== null && catCount >= caps.maxPerCategory) continue;

    chosen.push(sc);
    perCategory.set(cat, catCount + 1);
    perHost.set(host, hostCount + 1);
  }

  return chosen;
}

/**
 * Diversity, with a relaxation ladder.
 *
 * Try to fill the deck with every cap enforced. If the pool is not varied
 * enough — twelve posts from seven hosts cannot fill eight slots at one per
 * host — give up exactly one cap, in the documented order, and try again.
 *
 * The ladder matters. The naive version (dump the skipped cards back in) gives
 * up every cap at once, so a pool short on hosts also loses its category limit
 * and the deck comes back as six coffees. Relaxing one at a time keeps the
 * constraints that are still satisfiable.
 */
function applyDiversity(
  scored: readonly ScoredCandidate[],
  deckSize: number,
  relaxations: string[],
): ScoredCandidate[] {
  const ladder = CONSTANTS.slate.relaxationOrder.filter(
    (name): name is 'maxPerHost' | 'maxPerCategory' => name !== 'minFreshHostInTop',
  );

  const caps: Caps = {
    maxPerHost: CONSTANTS.slate.maxPerHost,
    maxPerCategory: CONSTANTS.slate.maxPerCategory,
  };

  let chosen = greedyPick(scored, deckSize, caps);

  for (const name of ladder) {
    if (chosen.length >= deckSize) break;
    caps[name] = null;
    relaxations.push(name);
    chosen = greedyPick(scored, deckSize, caps);
  }

  return chosen;
}

/**
 * Guarantee a fresh host in the top slots.
 *
 * A post from a host the viewer has never seen is promoted into the top window
 * regardless of score — once per deck. It displaces the *lowest-scoring* card
 * in that window rather than the top one, so the cost of the guarantee is paid
 * by position 3, not position 1.
 *
 * If the deck contains no fresh-host card at all, the guarantee is recorded as
 * relaxed. That is information, not a failure: it means supply has gone stale.
 */
function ensureFreshHostInTop(
  cards: ScoredCandidate[],
  relaxations: string[],
): ScoredCandidate[] {
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
 */
function applyExploreEpsilon(cards: ScoredCandidate[], rng: Rng): ScoredCandidate[] {
  const pos = CONSTANTS.slate.exploreSwapPosition;
  if (cards.length <= pos + 1) return cards;

  // Draw the epsilon coin unconditionally so that the Rng consumes the same
  // number of values whether or not the swap happens. Otherwise the sequence
  // desynchronises and determinism becomes deck-length-dependent.
  const roll = rng();
  const pick = rng();
  if (roll >= CONSTANTS.slate.exploreEpsilon) return cards;

  const lowerCount = cards.length - (pos + 1);
  const target = pos + 1 + Math.floor(pick * lowerCount);

  const out = cards.slice();
  const a = out[pos] as ScoredCandidate;
  const b = out[target] as ScoredCandidate;
  out[pos] = b;
  out[target] = a;
  return out;
}

/** Assemble the deck: diversity, then the fresh-host guarantee, then explore. */
export function assembleSlate(
  scored: readonly ScoredCandidate[],
  rng: Rng,
  deckSize: number = CONSTANTS.slate.deckSize,
): SlateResult {
  const relaxations: string[] = [];
  if (scored.length === 0) return { cards: [], relaxations };

  const size = Math.min(deckSize, scored.length);
  let cards = applyDiversity(scored, size, relaxations);
  cards = ensureFreshHostInTop(cards, relaxations);
  cards = applyExploreEpsilon(cards, rng);

  return { cards, relaxations };
}
